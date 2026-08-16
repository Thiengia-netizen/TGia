// server/btp-nvl-sync.js
//
// MODULE DUY NHẤT chịu trách nhiệm đồng bộ Danh Mục NVL <-> 2 file BTP.
// QUY TẮC CHUẨN (chỉ định nghĩa 1 lần ở đây, dùng lại ở mọi nơi):
//
//   1. "🍲 Nhóm BTP" trong Danh Mục NVL CHỈ được chứa đúng những món đang
//      có công thức thật ở data.btp_recipes.khapkhun. Món
//      nào không còn công thức -> bị đẩy ra "📦 Nhóm Hàng Khô" (không xoá).
//
//   2. Mỗi món BTP đang có công thức LUÔN có đúng 1 dòng NVL cùng tên,
//      cùng ĐVT, nhóm "🍲 Nhóm BTP".
//
//   3. GIÁ của dòng NVL đó:
//        - Nếu CHƯA từng "Sản Xuất Mẻ" (nguồn giá = 'uoc_tinh'): giá luôn
//          được TÍNH LẠI SỐNG từ công thức hiện tại (định lượng NVL thô ×
//          giá NVL thô hiện tại ÷ SL danh nghĩa/mẻ) — mọi chỉnh sửa công
//          thức trong file BTP phản ánh ngay vào NVL, đúng yêu cầu.
//        - Nếu ĐÃ từng "Sản Xuất Mẻ" (nguồn giá = 'san_xuat'): giữ nguyên
//          giá THẬT từ lần sản xuất gần nhất (chính xác hơn vì phản ánh
//          đúng hao hụt thực tế lúc nấu) — không bị hàm này ghi đè.
//
// HÀM reconcileBtpNvl() được gọi ở MỌI nơi dữ liệu đi qua: đọc (GET
// /api/state, GET /api/btp/recipes), ghi (PUT /api/state, mọi API trong
// server/btp.js), và lúc khởi động server (server/db.js) — để dù dữ liệu
// đến/đi từ đâu, Nhóm BTP luôn đúng ngay lập tức, không phụ thuộc thứ tự
// thao tác hay dữ liệu cũ trình duyệt gửi lên.

function normName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function unitType(dvt) {
  const u = (dvt || '').trim().toLowerCase();
  return (u === 'kg' || u === 'lít' || u === 'lit' || u === 'l') ? 'mass' : 'count';
}

/** Giá vốn cả mẻ theo công thức, dùng giá NVL thô HIỆN TẠI trong data.nvl. */
function calcRecipeCostEstimate(dish, nvlList) {
  let total = 0;
  for (const ing of (dish.ingredients || [])) {
    const nvlItem = nvlList.find(n => normName(n.ten) === normName(ing.ten));
    if (!nvlItem) continue;
    const qty = (Number(ing.dinh_luong) || 0) / (unitType(nvlItem.dvt) === 'mass' ? 1000 : 1);
    total += qty * (Number(nvlItem.gia) || 0) * (1 + (Number(ing.hao_hut) || 0));
  }
  return total;
}

function estimatedUnitPrice(dish, nvlList) {
  const total = calcRecipeCostEstimate(dish, nvlList);
  return dish.output_qty > 0 ? +(total / dish.output_qty).toFixed(2) : 0;
}

/**
 * Đồng bộ lại data.nvl cho khớp data.btp_recipes.khapkhun theo
 * đúng 3 quy tắc ở đầu file. Trả về true nếu có bất kỳ thay đổi nào.
 * AN TOÀN: không bao giờ đụng tới giá đã được "Sản Xuất Mẻ" xác nhận.
 */
function reconcileBtpNvl(data) {
  if (!Array.isArray(data.nvl)) data.nvl = [];
    let changed = false;

  // Tự động giải phóng "bia mộ" trong nvl_deleted nếu món BTP đó đã được tạo lại công thức
  if (Array.isArray(data.nvl_deleted) && data.btp_recipes) {
    const activeBtpKeys = new Set();
    for (const branch of ['khapkhun']) {
      for (const d of (data.btp_recipes[branch] || [])) {
        if (d && d.name) activeBtpKeys.add(normName(d.name));
      }
    }
    
    // Nếu tên nằm trong danh sách xóa nhưng thực tế đang có công thức hoạt động, xóa tên đó khỏi nvl_deleted
    const beforeDeletedLength = data.nvl_deleted.length;
    data.nvl_deleted = data.nvl_deleted.filter(name => !activeBtpKeys.has(normName(name)));
    if (data.nvl_deleted.length !== beforeDeletedLength) changed = true;
  }

  // Danh sách tên NVL đã thực sự bị xóa (sau khi đã lọc bỏ các món được hồi sinh)
  const deletedSet = new Set((data.nvl_deleted || []).map(normName));

  if (deletedSet.size > 0) {
    const before = data.nvl.length;
    data.nvl = data.nvl.filter(n => !deletedSet.has(normName(n.ten)));
    if (data.nvl.length !== before) changed = true;
  }


  if (!data.btp_recipes) { data.btp_raw_expansion = data.btp_raw_expansion || {}; return changed; }

  // Gom món BTP theo tên (không phân biệt hoa/thường, khoảng trắng)
  const dishByName = new Map();
  for (const branch of ['khapkhun']) {
    for (const d of (data.btp_recipes[branch] || [])) {
      if (!d || !d.name) continue;
      const key = normName(d.name);
      const prev = dishByName.get(key);
      if (!prev || (d.ingredients || []).length > (prev.ingredients || []).length) {
        dishByName.set(key, d);
      }
    }
  }

  // 1. Đẩy ra khỏi Nhóm BTP những NVL không còn khớp món BTP nào
  for (const n of data.nvl) {
    if (n.nhom === '🍲 Nhóm BTP' && !dishByName.has(normName(n.ten))) {
      n.nhom = '📦 Nhóm Hàng Khô';
      changed = true;
    }
  }

  // 2. Đảm bảo mọi món BTP hiện có đều có đúng 1 dòng NVL, đúng nhóm,
  //    đúng ĐVT, và giá luôn sống theo công thức nếu chưa từng sản xuất.
  for (const [key, dish] of dishByName) {
    if (deletedSet.has(key)) continue; // người dùng đã xoá chủ động -> không tự tạo lại
    let row = data.nvl.find(n => normName(n.ten) === key);
    const dvt = dish.output_unit || 'kg';

    if (!row) {
      const maxId = Math.max(0, ...data.nvl.map(n => n.id || 0));
      row = {
        id: maxId + 1,
        ten: dish.name,
        dvt,
        gia: estimatedUnitPrice(dish, data.nvl),
        nhom: '🍲 Nhóm BTP',
        btp_gia_nguon: 'uoc_tinh',
      };
      data.nvl.push(row);
      changed = true;
      continue;
    }

    if (row.nhom !== '🍲 Nhóm BTP') { row.nhom = '🍲 Nhóm BTP'; changed = true; }
    if (row.dvt !== dvt) { row.dvt = dvt; changed = true; }

    // Dòng NVL cũ (tạo trước khi có cơ chế theo dõi nguồn giá) chưa có
    // btp_gia_nguon -> coi như 'uoc_tinh' để bắt đầu tính sống từ đây.
    if (!row.btp_gia_nguon) row.btp_gia_nguon = 'uoc_tinh';

    if (row.btp_gia_nguon === 'uoc_tinh') {
      const gia = estimatedUnitPrice(dish, data.nvl);
      if (row.gia !== gia) { row.gia = gia; changed = true; }
    }
    // Nếu btp_gia_nguon === 'san_xuat': giữ nguyên giá thật, không đụng vào.
  }

  // Luôn tính lại bảng quy đổi BOM đa cấp (rẻ, dữ liệu nhỏ) để mọi thay đổi
  // công thức/giá NVL thô phản ánh ngay vào cách tính xuất kho NVL thô.
  const newExpansion = resolveBtpRawExpansion(data);
  if (JSON.stringify(data.btp_raw_expansion || {}) !== JSON.stringify(newExpansion)) {
    changed = true;
  }
  data.btp_raw_expansion = newExpansion;

  return changed;
}

/**
 * BOM ĐA CẤP: với mỗi món BTP, "phẳng hoá" toàn bộ công thức của nó (kể cả
 * khi công thức đó lại dùng 1 món BTP khác làm nguyên liệu — đệ quy nhiều
 * cấp) thành 1 bảng quy đổi DUY NHẤT ra NVL THÔ, tính theo "cần bao nhiêu
 * NVL thô cho MỖI 1 đơn vị (kg/lít/cái...) thành phẩm BTP đó".
 *
 * Ví dụ đúng như yêu cầu: BTP "Nước hầm xương" 50 lít cần 3kg Xương hầm.
 *   -> quy đổi: 1 lít Nước hầm xương = 3/50 = 0.06 kg Xương hầm.
 * Khi món "Tô Phở" dùng 400ml (0.4 lít) Nước hầm xương, hệ thống tự suy ra
 * phải trừ tồn kho NVL THÔ "Xương hầm": 0.4 × 0.06 = 0.024kg / tô.
 *
 * Trả về: { [tenBtpChuẩnHoá]: { [tenNvlThô]: soLuongNvlThoTrenMoiDonViBtp } }
 * Chỉ chứa NVL THÔ ở tầng lá cuối cùng (đã đệ quy hết mọi tầng BTP lồng
 * nhau) — nơi dùng bảng này (tính xuất kho) không cần biết có bao nhiêu
 * tầng trung gian, chỉ cần tra thẳng ra NVL thô.
 */
function resolveBtpRawExpansion(data) {
  const dishByName = new Map();
  for (const branch of ['khapkhun']) {
    for (const d of (data.btp_recipes?.[branch] || [])) {
      if (!d || !d.name) continue;
      const key = normName(d.name);
      const prev = dishByName.get(key);
      if (!prev || (d.ingredients || []).length > (prev.ingredients || []).length) {
        dishByName.set(key, d);
      }
    }
  }
  const nvlByName = new Map((data.nvl || []).map(n => [normName(n.ten), n]));
  const cache = new Map();
  const visiting = new Set(); // chống vòng lặp công thức (A dùng B, B lại dùng A)

  function expand(key) {
    if (cache.has(key)) return cache.get(key);
    const dish = dishByName.get(key);
    if (!dish || !dish.output_qty || visiting.has(key)) { cache.set(key, {}); return {}; }
    visiting.add(key);
    const result = {};
    const outputQty = dish.output_qty; // tổng SL thành phẩm danh nghĩa cả mẻ
    for (const ing of (dish.ingredients || [])) {
      const ingKey = normName(ing.ten);
      const nvlItem = nvlByName.get(ingKey);
      const isMass = nvlItem ? (unitType(nvlItem.dvt) === 'mass') : true;
      const qtyPerBatch = (Number(ing.dinh_luong) || 0) / (isMass ? 1000 : 1); // đơn vị kho, cả mẻ
      const qtyPerOutputUnit = (qtyPerBatch / outputQty) * (1 + (Number(ing.hao_hut) || 0));
      if (dishByName.has(ingKey) && ingKey !== key) {
        // Nguyên liệu này lại LÀ 1 món BTP khác -> đệ quy phẳng hoá tiếp
        const sub = expand(ingKey);
        for (const [rawName, rawRatio] of Object.entries(sub)) {
          result[rawName] = (result[rawName] || 0) + qtyPerOutputUnit * rawRatio;
        }
      } else {
        result[ing.ten] = (result[ing.ten] || 0) + qtyPerOutputUnit;
      }
    }
    visiting.delete(key);
    cache.set(key, result);
    return result;
  }

  const out = {};
  for (const key of dishByName.keys()) out[key] = expand(key);
  return out;
}

/** Gọi ngay sau khi 1 mẻ BTP được "Sản Xuất" thành công — đánh dấu giá này
 * là giá THẬT, để reconcileBtpNvl() không ghi đè bằng giá ước tính nữa. */
function markBtpGiaSanXuat(nvlRow, gia) {
  nvlRow.gia = gia;
  nvlRow.btp_gia_nguon = 'san_xuat';
  nvlRow.nhom = '🍲 Nhóm BTP';
}

/**
 * 🔒 LỚP CHỐT AN TOÀN THẬT SỰ — gọi hàm này TRƯỚC KHI trả dữ liệu (GET) hoặc
 * broadcast (state-updated) cho BẤT KỲ client nào, để đảm bảo công thức BTP
 * (và mọi thứ có thể suy ra công thức) KHÔNG BAO GIỜ rời khỏi server nếu
 * người nhận không có quyền BTP, dù họ có mở Console trình duyệt cũng không
 * lấy được, vì dữ liệu chưa từng được gửi xuống máy họ.
 * Super Admin luôn được xem đầy đủ, không lọc gì.
 */
function filterBtpSecrets(data, user) {
  if (!data || typeof data !== 'object') return data;
  if (user?.is_superadmin) return data;
  const perm = data.user_btp_tabs?.[user?.id] || [];
  const canKK = perm.includes('btp-khapkhun');
  if (canKK) return data; // đủ quyền -> không cần lọc gì

  const out = { ...data };
  if (out.btp_recipes) out.btp_recipes = { khapkhun: [] };
  if (out.btp_recipes_deleted) out.btp_recipes_deleted = { khapkhun: [] };
  if (out.btp_production) {
    const filtered = {};
    for (const mk of Object.keys(out.btp_production)) filtered[mk] = [];
    out.btp_production = filtered;
  }
  out.btp_raw_expansion = {};

  return out;
}

module.exports = { normName, reconcileBtpNvl, calcRecipeCostEstimate, estimatedUnitPrice, markBtpGiaSanXuat, resolveBtpRawExpansion, filterBtpSecrets };
