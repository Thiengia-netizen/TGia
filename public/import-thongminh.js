// ═══════════════════════════════════════════════════════════════
// 📁 IMPORT THÔNG MINH — tự đọc Bill NVL / Chi Phí / Hủy Hàng / Chấm Công
// từ file Excel, ảnh (OCR) hoặc PDF, rồi đồng bộ vào đúng tab.
// File này CHẠY SAU script chính (cần S, saveData, mkey, sortAZ, fmt...
// đã tồn tại trong window khi các hàm bên dưới thực sự được gọi).
// ═══════════════════════════════════════════════════════════════

let _impLoai = 'nvl';          // nvl | chiphi | huyhang | chamcong | taicho | banhang
let _impRows = [];             // các dòng đã parse, đang chờ xem trước / sửa / lưu
let _impNgayChung = '';      // 📅 "Ngày chung" — chỉnh 1 lần, áp dụng cho TOÀN BỘ các dòng Bán Hàng / Nhập Hàng NVL / Hủy Hàng đang xem trước
let _impRowSeq = 0;
let _impLastMonTen = '';       // hỗ trợ đọc Excel công thức có ô "Tên món" bị gộp (merge)
let _impUsedFallback = false;  // đánh dấu lần đọc gần nhất có phải "đoán cột" hay không (file không có tiêu đề)

// ── Từ khoá đoán Nhóm NVL khi tạo NVL mới từ import ──────────────
const IMP_NHOM_KEYWORDS = [
  ['🥬 Nhóm Rau Củ', ['rau','cải','cà chua','cà rốt','hành','tỏi','ớt','chanh','bắp','khoai','dưa','giá đỗ','ngò','ngải','bí','đậu que','đậu bắp','nấm','xà lách','bầu']],
  ['🥩 Nhóm Thịt & Cá', ['thịt','heo','bò','gà','vịt','cá','tôm','mực','xương','sườn','ba chỉ','nạc','giò','chả lụa']],
  ['📦 Nhóm Hàng Khô', ['bún','hủ tiếu','mì','bánh phở','bánh tráng','gạo','đường','bột','khô','miến']],
  ['🧂 Nhóm Gia Vị', ['muối','tiêu','nước mắm','sa tế','tương','dầu ăn','giấm','bột ngọt','hạt nêm','me','sả','riềng','nước cốt dừa']],
  ['🍢 Nhóm Món Thêm', ['trứng','chả','viên','xúc xích']],
];
function guessNhomNVL(ten) {
  const t = (ten || '').toLowerCase();
  for (const [nhom, kws] of IMP_NHOM_KEYWORDS) {
    if (kws.some(k => t.includes(k))) return nhom;
  }
  return '📦 Nhóm Hàng Khô';
}

// ── So khớp gần đúng tên NVL / Nhân viên đã có trong hệ thống ────
function impNormalize(s) {
  return (s || '').toString().normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}
// 🇻🇳 Bỏ dấu tiếng Việt để so khớp gần đúng — nhân viên hay gõ/OCR ra thiếu dấu
// (vd "Hanh la" phải khớp được với "Hành lá" đã có trong hệ thống, không được coi là NVL mới)
function impFold(s) {
  return impNormalize(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // tách & bỏ dấu thanh (à,á,ả,ã,ạ,...)
    .replace(/đ/g, 'd');
}
function impLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}
// So khớp gần đúng dùng chung cho NVL / Nhân viên / Món: ưu tiên khớp NGUYÊN VĂN có dấu trước,
// sau đó khớp NGUYÊN VĂN bỏ dấu (gõ/OCR thiếu dấu vẫn nhận ra), cuối cùng mới tới Levenshtein bỏ dấu.
function impBestMatch(list, ten, getTen) {
  const q = impNormalize(ten);
  if (!q) return null;
  let exact = (list || []).find(x => impNormalize(getTen(x)) === q);
  if (exact) return exact;
  const qf = impFold(ten);
  if (!qf) return null;
  let exactFold = (list || []).find(x => impFold(getTen(x)) === qf);
  if (exactFold) return exactFold;
  let best = null, bestScore = 0;
  for (const x of (list || [])) {
    const cand = impFold(getTen(x));
    const dist = impLevenshtein(qf, cand);
    const score = 1 - dist / Math.max(qf.length, cand.length, 1);
    if (score > bestScore) { bestScore = score; best = x; }
  }
  return bestScore >= 0.75 ? best : null;
}
// Trả về NVL khớp nhất trong S.nvl (hoặc null nếu không đủ giống)
function impMatchNVL(ten) { return impBestMatch(S.nvl, ten, n => n.ten); }
function impMatchStaff(ten) { return impBestMatch(S.staff || [], ten, n => n.ten); }

// ── Chuẩn hoá ngày về YYYY-MM-DD, hỗ trợ dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd,
// dd/mm (không năm → lấy năm hiện tại), Date object thật (ô Excel định dạng Ngày),
// và số serial ngày thô của Excel (phòng khi cellDates không áp dụng được) ──
function impParseDate(val) {
  if (val === null || val === undefined || val === '') return null;
  // 📅 Ô Excel được ĐỊNH DẠNG NGÀY THẬT → SheetJS (cellDates:true) trả về đối tượng Date,
  // KHÔNG phải chuỗi "dd/mm/yyyy" như code cũ tưởng → trước đây bị String(Date) ra dạng
  // "Fri Aug 07 2026 GMT+..." không khớp regex nào → luôn null → tự rơi về "hôm nay".
  // 📅 Ô Excel được ĐỊNH DẠNG NGÀY THẬT → SheetJS (cellDates:true) trả về đối tượng Date,
  // KHÔNG phải chuỗi "dd/mm/yyyy" như code cũ tưởng → trước đây bị String(Date) ra dạng
  // "Fri Aug 07 2026 GMT+..." không khớp regex nào → luôn null → tự rơi về "hôm nay".
  // Dùng kiểm tra kiểu "vịt lai" (duck-typing) thay vì instanceof Date để không bị lỗi
  // khi đối tượng Date được tạo ra ở 1 bối cảnh JS khác (vd module/iframe khác).
  const isDateLike = val && typeof val === 'object' && typeof val.getUTCFullYear === 'function' && typeof val.getTime === 'function' && !isNaN(val.getTime());
  if (isDateLike) {
    const y = val.getUTCFullYear(), m = val.getUTCMonth() + 1, d = val.getUTCDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  // Số serial ngày thô kiểu Excel (vd 46237) — chỉ áp dụng cho cột đã xác định là NGÀY nên an toàn
  if (typeof val === 'number' && val > 20000 && val < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(val) * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(val).trim();
  if (!s) return null;
  let m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let y = m[3].length === 2 ? '20' + m[3] : m[3];
    let d1 = parseInt(m[1], 10), d2 = parseInt(m[2], 10);
    // ⚠️ CHỐT AN TOÀN QUAN TRỌNG: mặc định coi số 1 là NGÀY, số 2 là THÁNG
    // (kiểu dd/mm/yyyy Việt Nam) — nhưng nếu số 2 (được coi là "tháng") lớn
    // hơn 12, đó chắc chắn KHÔNG PHẢI tháng hợp lệ -> file gốc thực ra đang
    // ghi theo kiểu mm/dd/yyyy (Mỹ) -> tự đảo lại ngày/tháng cho đúng.
    // TRƯỚC ĐÂY: cứ ghép thẳng "tháng"=số2>12 -> tạo ra ngày HỎNG (vd tháng
    // 13), phiếu bị lưu vào 1 "tháng ma" không tồn tại trên bất kỳ bộ lọc
    // nào -> nhìn như "biến mất" dù dữ liệu vẫn còn, chỉ là không tìm lại
    // được. Từ giờ KHÔNG BAO GIỜ được phép tạo ra tháng ngoài 1-12.
    let day = d1, month = d2;
    if (month > 12 && day <= 12) { day = d2; month = d1; } // tự đảo lại nếu phát hiện kiểu mm/dd/yyyy
    if (month > 12 || month < 1 || day > 31 || day < 1) return null; // vẫn hỏng dù đã thử đảo -> bỏ qua, không đoán bừa
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  // Chỉ có ngày/tháng, KHÔNG có năm (vd "7/8") → mặc định lấy năm hiện tại
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    const y = new Date().getFullYear();
    let d1 = parseInt(m[1], 10), d2 = parseInt(m[2], 10);
    let day = d1, month = d2;
    if (month > 12 && day <= 12) { day = d2; month = d1; }
    if (month > 12 || month < 1 || day > 31 || day < 1) return null;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}
// Tìm ngày chứng từ xuất hiện đầu tiên trong cả đoạn text OCR
function impFindGlobalDate(text) {
  const m = text.match(/(\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4})/);
  return m ? impParseDate(m[1]) : null;
}
function impMoneyToNumber(str) {
  if (typeof str === 'number') return str;
  if (!str) return 0;
  const cleaned = String(str).replace(/[^\d.,]/g, '');
  // Ưu tiên coi dấu chấm/phẩy là phân cách nghìn (kiểu VN: 25.000)
  const noSep = cleaned.replace(/[.,](?=\d{3}(\D|$))/g, '');
  const num = parseFloat(noSep.replace(',', '.'));
  return isNaN(num) ? 0 : num;
}

// ── Áp dụng lựa chọn "Khớp Với" thủ công (nếu người dùng đã chọn ở dropdown) ──
// r._mapOverride: undefined => để hệ thống tự dò (mặc định) | 'new' => LUÔN tạo mới, bỏ qua tự dò | number => ID món/NVL/NV được chọn tay
function impResolveNVL(r) {
  if (r._mapOverride === 'new') return null;
  if (typeof r._mapOverride === 'number') return S.nvl.find(n => n.id === r._mapOverride) || null;
  return impMatchNVL(r.ten);
}
function impResolveStaff(r) {
  if (r._mapOverride === 'new') return null;
  if (typeof r._mapOverride === 'number') return (S.staff || []).find(n => n.id === r._mapOverride) || null;
  return impMatchStaff(r.nhan_vien);
}
function impResolveMonIn(list, r, tenField) {
  if (r._mapOverride === 'new') return null;
  if (typeof r._mapOverride === 'number') return (list || []).find(m => m.id === r._mapOverride) || null;
  return impMatchMonIn(list, r[tenField]);
}
function impMatchMonIn(list, ten) { return impBestMatch(list, ten, m => m.ten); }

// ── 🔗 "Sổ tay" nhớ tên đã map thủ công (POS thường ghi tên rất khác tên hệ thống,
// vd "combo xương khủng long và cơm heo xào" ↔ "combo xương+ cơm" — so khớp mờ theo
// ký tự KHÔNG thể tự nhận ra 2 tên đó là 1, nên khi người dùng đã chọn tay 1 lần,
// hệ thống ghi nhớ lại để lần import sau tự nhận luôn, không phải chọn lại) ──
function impAliasGet(ten) {
  if (!S.import_ten_alias) S.import_ten_alias = {};
  const key = impFold(ten);
  if (!key) return null;
  const a = S.import_ten_alias[key];
  if (!a) return null;
  const list = a.type === 'taicho' ? S.menu_taicho : a.type === 'combo' ? S.combos : S.menu;
  const mon = (list || []).find(m => m.id === a.id);
  return mon ? { type: a.type, mon } : null;
}
function impAliasSave(ten, type, id) {
  if (!S.import_ten_alias) S.import_ten_alias = {};
  const key = impFold(ten);
  if (!key || !type || !id) return;
  S.import_ten_alias[key] = { type, id };
}
// Tự dò món khớp trên CẢ 3 nơi (Tại Chỗ / Bán Hàng App / Combo), ưu tiên: sổ tay đã nhớ
// → Tại Chỗ → App → Combo. Trả về { target:'taicho'|'menu'|'combo', mon } hoặc null.
function impAutoDetectTarget(ten) {
  const remembered = impAliasGet(ten);
  if (remembered) return { target: remembered.type, mon: remembered.mon };
  const tc = impMatchMonIn(S.menu_taicho, ten);
  if (tc) return { target: 'taicho', mon: tc };
  const ap = impMatchMonIn(S.menu, ten);
  if (ap) return { target: 'menu', mon: ap };
  const cb = impMatchMonIn(S.combos || [], ten);
  if (cb) return { target: 'combo', mon: cb };
  return null;
}

// ══════════ TAB & FILE INPUT ══════════
function onImportLoaiChange() {
  _impLoai = document.getElementById('imp-loai').value;
  const hintEl = document.getElementById('imp-loai-hint');
  const hints = {
    nvl: '🚚 Sẽ đọc: tên NVL, số lượng, đơn vị, đơn giá, ngày nhập → lưu vào tab Nhập Hàng.',
    chiphi: '💸 Sẽ đọc: tên khoản chi, số tiền → lưu vào tab Chi Phí (bạn chọn Nhóm/Loại trước khi lưu).',
    huyhang: '🗑 Sẽ đọc: tên NVL, số lượng, ngày, lý do (nếu có) → lưu vào tab Hủy Hàng.',
    chamcong: '👥 Sẽ đọc: tên nhân viên, ngày, số giờ công → lưu vào tab Chấm Công.',
    taicho: '🏠 Sẽ đọc: tên món, tên nguyên liệu, định lượng → cập nhật công thức món trong Menu Tại Chỗ (ảnh: mỗi ảnh = 1 món; Excel: nhiều món 1 file).',
    banhang: '🛒 Sẽ đọc: tên món, số lượng bán → cộng vào tab Bán Hàng / Menu Tại Chỗ / Combo theo đúng ngày (tự dò khớp món ở cả 3 nơi, có nhớ tên đã map tay).'
  };
  if (hintEl) hintEl.textContent = hints[_impLoai] || '';
  _impRows = [];
  _impNgayChung = '';
  window._impMonMapOverride = {};
  renderImportPreview();
}

async function onImportFilesSelected() {
  const input = document.getElementById('imp-files');
  const files = Array.from(input.files || []);
  if (!files.length) return;
  const statusEl = document.getElementById('imp-status');
  const progEl = document.getElementById('imp-progress');

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (statusEl) statusEl.textContent = `⏳ Đang xử lý (${i + 1}/${files.length}): ${f.name}...`;
    _impUsedFallback = false;
    try {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      let newRows = [];
      if (['xlsx', 'xls', 'csv'].includes(ext)) {
        newRows = await impParseExcelFile(f);
      } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        const text = await impOcrImage(f, progEl);
        newRows = impParseTextToRows(text);
      } else if (ext === 'pdf') {
        const text = await impExtractPdfText(f, progEl);
        newRows = impParseTextToRows(text);
      } else {
        alert(`⚠️ Không hỗ trợ định dạng file: ${f.name}`);
        continue;
      }
      newRows.forEach(r => { r._id = ++_impRowSeq; r._include = true; r._source = f.name; });
      _impRows = _impRows.concat(newRows);
    } catch (err) {
      console.error(err);
      alert(`❌ Lỗi đọc file ${f.name}: ${err.message}`);
    }
  }
  if (progEl) progEl.innerHTML = '';
  // 📅 Bán Hàng: hầu hết báo cáo POS (Grab/Shopee/App) KHÔNG có cột ngày riêng từng dòng.
  // Tự đặt "Ngày bán chung" 1 lần (ưu tiên ngày đọc được từ file nếu có, không thì hôm nay),
  // rồi áp cho MỌI dòng chưa có ngày — người dùng chỉ cần sửa lại 1 ô là cả loạt cùng đổi theo.
  // 📅 Bán Hàng / Nhập Hàng NVL / Hủy Hàng: hầu hết báo cáo (POS, hoá đơn nhà
  // cung cấp...) KHÔNG có cột ngày riêng từng dòng, hoặc muốn nhập nhanh cả
  // lô cùng 1 ngày. Tự đặt "Ngày chung" 1 lần (ưu tiên ngày đọc được từ file
  // nếu có, không thì hôm nay), rồi áp cho MỌI dòng chưa có ngày — người
  // dùng chỉ cần sửa lại 1 ô là cả loạt cùng đổi theo.
  if (_impLoai === 'banhang' || _impLoai === 'nvl' || _impLoai === 'huyhang') {
    if (!_impNgayChung) {
      const detected = _impRows.find(r => r.ngay)?.ngay;
      _impNgayChung = detected || new Date().toISOString().slice(0, 10);
    }
    _impRows.forEach(r => { if (!r.ngay) r.ngay = _impNgayChung; });
  }
  if (statusEl) statusEl.textContent = `✅ Đã đọc xong ${files.length} file — ${_impRows.length} dòng dữ liệu tìm được.${_impUsedFallback ? ' ⚠️ File không có dòng tiêu đề rõ ràng nên hệ thống đã TỰ ĐOÁN cột theo dữ liệu — kiểm tra kỹ từng cột bên dưới trước khi lưu!' : ''} Kiểm tra & sửa bên dưới trước khi Lưu.`;
  input.value = '';
  renderImportPreview();
}

// ══════════ ĐỌC EXCEL / CSV (SheetJS) ══════════
const IMP_COL_ALIASES = {
  ngay: ['ngày', 'ngay', 'date'],
  phan_loai: ['phân loại', 'phan loai'],
  ten: ['tên nvl', 'ten nvl', 'tên hàng', 'tên', 'ten', 'sản phẩm', 'mặt hàng', 'name', 'khoản chi', 'nội dung'],
  sl: ['số lượng', 'so luong', 'sl', 'qty', 'quantity'],
  dvt: ['đvt', 'dvt', 'đơn vị', 'don vi', 'unit'],
  gia: ['đơn giá', 'don gia', 'giá', 'gia', 'price', 'unit price'],
  thanh_tien: ['thành tiền', 'thanh tien', 'total', 'tổng tiền', 'so tien', 'số tiền'],
  ly_do: ['lý do', 'ly do', 'reason'],
  nhom: ['nhóm', 'nhom', 'group'],
  loai: ['loại', 'loai', 'type'],
  nhan_vien: ['nhân viên', 'nhan vien', 'họ tên', 'ho ten', 'staff', 'tên nv'],
  gio: ['số giờ', 'giờ công', 'gio', 'giờ', 'hours', 'công'],
  ten_mon: ['tên món', 'ten mon', 'món ăn', 'mon an', 'món', 'tên sản phẩm', 'sản phẩm', 'dish', 'product', 'item', 'tên sốt', 'ten sot'],
  dinh_luong: ['định lượng', 'dinh luong', 'đluong', 'dl (g/ml)', 'khối lượng']
};
function impEscRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// 🧠 So khớp tên cột theo ĐIỂM (score), không phải "khớp đầu tiên tìm thấy":
//  - Khớp NGUYÊN VĂN cả tiêu đề (vd "Tên món" == "tên món") → điểm rất cao, luôn thắng.
//  - Khớp trọn TỪ trong tiêu đề (word-boundary, vd "món" trong "Tên món") → điểm = độ dài cụm từ.
//  - Mỗi CỘT chỉ được gán vào ĐÚNG 1 field có điểm cao nhất của chính cột đó.
//  - Nếu 2 cột cùng muốn nhận 1 field (vd cả "Mã món" và "Tên món" đều dính "món"),
//    cột có điểm cao hơn thắng → tránh lỗi "Mã món" bị hiểu nhầm thành "Tên món".
function impDetectCol(headerRow) {
  const colBest = {}; // idx -> { key, score }
  headerRow.forEach((h, idx) => {
    const hn = impNormalize(h);
    if (!hn) return;
    let bestKey = null, bestScore = 0;
    for (const [key, aliases] of Object.entries(IMP_COL_ALIASES)) {
      for (const a of aliases) {
        let score = 0;
        if (hn === a) score = 1000 + a.length; // khớp nguyên văn cả ô tiêu đề
        else if (new RegExp('(^|\\s)' + impEscRegex(a) + '($|\\s)').test(hn)) score = a.length; // khớp trọn từ/cụm
        if (score > bestScore) { bestScore = score; bestKey = key; }
      }
    }
    if (bestKey) colBest[idx] = { key: bestKey, score: bestScore };
  });
  const map = {};
  Object.keys(colBest).forEach(idxStr => {
    const idx = +idxStr, { key, score } = colBest[idx];
    if (map[key] === undefined || score > colBest[map[key]].score) map[key] = idx;
  });
  return map;
}
// 🏠 Đọc file "Chart Món/Công Thức" — hỗ trợ 2 kiểu bố cục thường gặp:
//  1) Mỗi SHEET là 1 món (tên món lấy từ TÊN SHEET), bảng nguyên liệu có
//     cột "Tên NVL" + "Định lượng" nằm ở đâu đó trong ~20 dòng đầu.
//  2) 1 sheet gộp NHIỀU món/BTP (vd "BTP- CÁC LOẠI SỐT"), có thêm 1 cột
//     riêng ghi tên món/tên sốt cho từng dòng (ô gộp — dòng nào trống thì
//     coi là món ở dòng trên).
// Sheet không tìm được cả 2 cột "Tên NVL" + "Định lượng" trong 20 dòng đầu
// (vd sheet quy trình thuần văn bản) sẽ được bỏ qua an toàn, không báo lỗi.
function impParseExcelTaiCho(wb) {
  const rows = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!raw.length) continue;

    let headerIdx = -1, cols = {};
    for (let i = 0; i < Math.min(raw.length, 20); i++) {
      const m = impDetectCol(raw[i]);
      if (m.ten !== undefined && m.dinh_luong !== undefined) { headerIdx = i; cols = m; break; }
    }
    if (headerIdx < 0) continue; // Không phải bảng công thức — bỏ qua sheet này

    const groupedMode = cols.ten_mon !== undefined;
    let lastMonTen = groupedMode ? '' : sheetName.trim();
    for (let i = headerIdx + 1; i < raw.length; i++) {
      const r = raw[i];
      if (!r || r.every(c => c === '' || c === null || c === undefined)) continue;
      const get = k => cols[k] !== undefined ? r[cols[k]] : '';
      if (groupedMode) {
        const mt = (get('ten_mon') || '').toString().trim();
        if (mt) lastMonTen = mt;
      }
      const nvlTen = (get('ten') || '').toString().trim();
      const dinhLuong = impMoneyToNumber(get('dinh_luong'));
      if (!nvlTen || !lastMonTen || !dinhLuong) continue; // dòng tiêu đề nhóm phụ / dòng quy trình xen kẽ
      rows.push(impMakeRow({ mon_ten: lastMonTen, ten: nvlTen, dvt: (get('dvt') || '').toString().trim(), dinh_luong: dinhLuong }));
    }
  }
  return rows;
}

function impLooksLikeUnit(v) {
  const s = (v || '').toString().trim().toLowerCase();
  if (!s) return false;
  return /^(kg|g|gr|lít|l|ml|hộp|thùng|bó|quả|trái|cái|chai|gói|con|kí|can|bao|cây|lon|hủ|keo)\b/.test(s) || /\d+\s*(kg|g|gr|l|ml|lít)\b/i.test(s);
}
// 🧠 Khi KHÔNG tìm được dòng tiêu đề nào khớp tên cột quen thuộc (file không
// có header, dữ liệu vào thẳng — vd danh sách bảng giá nhà cung cấp) — đoán
// vai trò từng cột dựa theo KIỂU DỮ LIỆU thực tế: cột nhiều số lớn (≥500) =
// giá; cột nhiều token kiểu "kg/g/lít/thùng..." = đơn vị/quy cách; cột chữ
// dài, gần như luôn có dữ liệu = tên; cột thưa (kiểu ô gộp, chỉ có ở 1 vài
// dòng đầu mỗi nhóm) = nhóm/nhà cung cấp/tên món (dùng carry-forward).
function impInferColumnsFallback(raw) {
  const nonEmptyRows = raw.filter(r => r && r.some(c => c !== '' && c != null));
  if (nonEmptyRows.length < 2) return null;
  const numCols = Math.max(...raw.map(r => r ? r.length : 0));
  const sample = nonEmptyRows.slice(0, 60);
  const stats = [];
  for (let c = 0; c < numCols; c++) {
    let numCount = 0, textLenSum = 0, textCount = 0, unitCount = 0, filled = 0;
    for (const r of sample) {
      const v = r[c];
      if (v === '' || v == null) continue;
      filled++;
      const isPureNum = typeof v === 'number' || /^[\d.,\s₫đvndVND]+$/.test(String(v).trim());
      if (isPureNum && impMoneyToNumber(v) >= 500) numCount++;
      else if (impLooksLikeUnit(v)) unitCount++;
      else { textLenSum += String(v).length; textCount++; }
    }
    stats.push({ c, numCount, unitCount, textCount, textLenSum, filled, fillRatio: filled / sample.length });
  }
  const giaCol = stats.slice().sort((a, b) => b.numCount - a.numCount)[0];
  if (!giaCol || giaCol.numCount === 0) return null; // Không có cột nào giống cột giá → không đủ tin cậy để đoán
  const dvtCol = stats.filter(s => s.c !== giaCol.c && s.unitCount > 0).sort((a, b) => b.unitCount - a.unitCount)[0];
  const tenCandidates = stats.filter(s => s.c !== giaCol.c && s.c !== dvtCol?.c && s.fillRatio > 0.5);
  if (!tenCandidates.length) return null;
  const tenCol = tenCandidates.sort((a, b) => (b.textLenSum / (b.textCount || 1)) - (a.textLenSum / (a.textCount || 1)))[0];
  const groupCol = stats.filter(s => s.c !== giaCol.c && s.c !== dvtCol?.c && s.c !== tenCol.c && s.fillRatio < 0.5 && s.fillRatio > 0.01)
    .sort((a, b) => b.fillRatio - a.fillRatio)[0];
  return { ten: tenCol.c, gia: giaCol.c, dvt: dvtCol?.c, nhom: groupCol?.c, _fallback: true };
}

async function impParseExcelFile(file) {
  if (typeof XLSX === 'undefined') throw new Error('Thư viện đọc Excel (SheetJS) chưa được tải.');
  _impLastMonTen = '';
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });

  // 🏠 Chart Món/Công Thức: file thường có NHIỀU SHEET (mỗi sheet 1 món hoặc
  // 1 nhóm món/BTP), tiêu đề bảng có thể nằm sâu vài dòng → xử lý riêng.
  if (_impLoai === 'taicho') return impParseExcelTaiCho(wb);

  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!raw.length) return [];

  // Tìm dòng tiêu đề: dò trong tối đa 15 dòng đầu (nhiều file có vài dòng
  // tiêu đề/ngày tháng phía trên bảng thật), khớp được >=2 cột đã biết
  let headerIdx = 0, cols = {};
  for (let i = 0; i < Math.min(raw.length, 15); i++) {
    const m = impDetectCol(raw[i]);
    if (Object.keys(m).length >= 2) { headerIdx = i; cols = m; break; }
  }
  // 🧠 Không tìm được tiêu đề nào phù hợp (file không có header, vd danh
  // sách bảng giá) → thử đoán cột theo kiểu dữ liệu, coi TOÀN BỘ file là dữ liệu.
  if (Object.keys(cols).length < 2) {
    const fb = impInferColumnsFallback(raw);
    if (fb) { cols = fb; headerIdx = -1; _impUsedFallback = true; }
  }
  const rows = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r || r.every(c => c === '' || c === null || c === undefined)) continue;
    const get = k => cols[k] !== undefined ? r[cols[k]] : '';
    if (_impLoai === 'chamcong') {
      // Hỗ trợ 2 kiểu: (tên, ngày, giờ) hoặc (tên, cột theo từng ngày trong tháng)
      if (cols.nhan_vien !== undefined && cols.gio !== undefined) {
        rows.push(impMakeRow({ nhan_vien: get('nhan_vien'), ngay: impParseDate(get('ngay')) || '', gio: impMoneyToNumber(get('gio')) }));
      } else if (cols.nhan_vien !== undefined) {
        // Kiểu bảng rộng: cột 1 là tên NV, các cột còn lại là ngày 1..31
        const tenNV = r[cols.nhan_vien];
        raw[headerIdx].forEach((h, ci) => {
          if (ci === cols.nhan_vien) return;
          const day = parseInt(h);
          const val = parseFloat(r[ci]);
          if (day >= 1 && day <= 31 && !isNaN(val) && val > 0) {
            rows.push(impMakeRow({ nhan_vien: tenNV, ngay_so: day, gio: val }));
          }
        });
      }
    } else if (_impLoai === 'banhang') {
      const phanLoai = impNormalize(get('phan_loai') || '');
      const laDongTuyChon = phanLoai.includes('tùy chọn') || phanLoai.includes('tuy chon');
      const monTen = (get('ten_mon') || get('ten') || '').toString().trim();
      const sl = impMoneyToNumber(get('sl'));
      if (monTen && sl && !laDongTuyChon) {
        const khoStr = impNormalize(monTen + ' ' + r.join(' '));
        rows.push(impMakeRow({ mon_ten: monTen, sl, ngay: impParseDate(get('ngay')) || '', kho: khoStr.includes('kho') && !khoStr.includes('khong') }));
      }
    } else if (_impLoai === 'chiphi') {
      rows.push(impMakeRow({
        ten: get('ten'), so_tien: impMoneyToNumber(get('thanh_tien') || get('gia')),
        nhom: get('nhom'), loai: get('loai')
      }));
    } else {
      // nvl / huyhang
      const sl = impMoneyToNumber(get('sl')) || 1;
      const gia = impMoneyToNumber(get('gia'));
      // File không có cột ngày (vd bảng giá nhà cung cấp) → mặc định hôm nay, sửa lại được ở bảng xem trước
      const ngay = impParseDate(get('ngay')) || new Date().toISOString().slice(0, 10);
      const nhaCungCap = cols._fallback && cols.nhom !== undefined ? (get('nhom') || '').toString().trim() : '';
      rows.push(impMakeRow({
        ngay, ten: get('ten'), sl, dvt: get('dvt') || '',
        gia: gia || (impMoneyToNumber(get('thanh_tien')) && sl ? impMoneyToNumber(get('thanh_tien')) / sl : 0),
        ly_do: get('ly_do') || '', _nha_cung_cap: nhaCungCap
      }));
    }
  }
  return rows.filter(r => r.ten || r.nhan_vien || r.mon_ten); // [FIX] dòng Bán Hàng dùng field mon_ten (không phải ten) — trước đây bị lọc mất hết
}

// ══════════ OCR ẢNH (Tesseract.js) ══════════
async function impOcrImage(file, progEl) {
  if (typeof Tesseract === 'undefined') throw new Error('Thư viện OCR (Tesseract.js) chưa được tải.');
  const { data } = await Tesseract.recognize(file, 'vie+eng', {
    logger: m => {
      if (progEl && m.status === 'recognizing text') {
        progEl.innerHTML = `<div class="fs11 txt-gray">🔎 Đang nhận diện chữ: ${Math.round((m.progress || 0) * 100)}%</div>`;
      }
    }
  });
  return data.text || '';
}

// ══════════ ĐỌC PDF (pdf.js) — ưu tiên lớp text số, nếu rỗng thì OCR ảnh trang ══════════
async function impExtractPdfText(file, progEl) {
  if (typeof pdfjsLib === 'undefined') throw new Error('Thư viện đọc PDF (pdf.js) chưa được tải.');
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let fullText = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    if (progEl) progEl.innerHTML = `<div class="fs11 txt-gray">📄 Đang đọc trang ${p}/${pdf.numPages}...</div>`;
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items.map(it => it.str).join(' ');
    if (pageText.trim().length > 20) {
      fullText += '\n' + pageText;
    } else {
      // Không có lớp text (PDF scan) → render ra ảnh rồi OCR
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const ocrText = await impOcrImage(blob, progEl);
      fullText += '\n' + ocrText;
    }
  }
  return fullText;
}

// ══════════ PHÂN TÍCH VĂN BẢN OCR THÀNH CÁC DÒNG DỮ LIỆU (rule-based) ══════════
const IMP_SKIP_LINE_KEYWORDS = ['stt', 'tổng cộng', 'tong cong', 'cộng', 'ký tên', 'ky ten', 'người bán', 'người mua', 'hóa đơn', 'hoa don', 'biên bản'];
function impMakeRow(fields) {
  return Object.assign({ ngay: '', ten: '', sl: 1, dvt: '', gia: 0, so_tien: 0, ly_do: '', nhom: '', loai: '', nhan_vien: '', gio: 0, ngay_so: null, mon_ten: '', dinh_luong: 0, kho: false, _nha_cung_cap: '', _mapOverride: undefined }, fields);
}
// Dựng danh sách <option> cho dropdown "Khớp Với" — tuỳ chọn đầu luôn là auto-detect / tạo mới
function impMapOptions(list, autoMatch, current, newLabel) {
  const opts = [`<option value="__auto__" ${current === undefined ? 'selected' : ''}>🔎 Tự động (${autoMatch ? '✅ ' + autoMatch.ten : '🆕 tạo mới'})</option>`];
  opts.push(`<option value="__new__" ${current === 'new' ? 'selected' : ''}>${newLabel}</option>`);
  sortAZ(list).forEach(item => {
    opts.push(`<option value="${item.id}" ${current === item.id ? 'selected' : ''}>${item.ten}</option>`);
  });
  return opts.join('');
}
function impRowSetMap(i, val) {
  if (!_impRows[i]) return;
  _impRows[i]._mapOverride = val === '__auto__' ? undefined : (val === '__new__' ? 'new' : parseInt(val));
  renderImportPreview();
}
// 🔗 Dùng riêng cho dòng Bán Hàng: khi người dùng chọn tay 1 món/combo có sẵn, GHI NHỚ luôn
// cặp (tên trong file POS ↔ món/combo đã chọn) vào sổ tay để lần import sau tự nhận diện.
function impRowSetMonMap(i, val) {
  const r = _impRows[i];
  if (!r) return;
  if (val === '__auto__') { r._mapOverride = undefined; }
  else if (val === '__new__') { r._mapOverride = 'new'; }
  else {
    const id = parseInt(val);
    r._mapOverride = id;
    if (r.mon_ten && r._target && r._target !== 'skip') impAliasSave(r.mon_ten, r._target, id);
  }
  renderImportPreview();
}
function impParseTextToRows(text) {
  const rows = [];
  const globalDate = impFindGlobalDate(text) || new Date().toISOString().slice(0, 10);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 📸 Ảnh/PDF công thức món: mặc định coi CẢ FILE là 1 món (1 ảnh = 1 thẻ công thức) —
  // dòng đầu tiên có chữ (không toàn số) là TÊN MÓN, các dòng sau là nguyên liệu.
  if (_impLoai === 'taicho') {
    const monTen = (lines.find(l => !/^\d+[\d.,\s]*$/.test(l) && l.length > 2) || '').trim();
    if (!monTen) return rows;
    for (const line of lines) {
      if (line === monTen) continue;
      const low = line.toLowerCase();
      if (IMP_SKIP_LINE_KEYWORDS.some(k => low.includes(k))) continue;
      const m = line.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(kg|g|gr|lít|l|ml|hộp|thùng|bó|quả|trái|cái|chai|gói|con|kí)?\s*$/i);
      if (m) {
        rows.push(impMakeRow({ mon_ten: monTen, ten: m[1].replace(/[-–.:]+$/, '').trim(), dinh_luong: parseFloat(m[2].replace(',', '.')), dvt: m[3] || '' }));
      }
    }
    return rows;
  }
  // 🧾 Ảnh/PDF báo cáo bán hàng: mỗi dòng "Tên món ... Số lượng"
  if (_impLoai === 'banhang') {
    for (const line of lines) {
      const low = line.toLowerCase();
      if (line.length < 3 || IMP_SKIP_LINE_KEYWORDS.some(k => low.includes(k))) continue;
      const m = line.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:phần|ly|tô|suất)?\s*$/i);
      if (m) {
        const monTen = m[1].replace(/[-–.:]+$/, '').trim();
        rows.push(impMakeRow({ mon_ten: monTen, sl: parseFloat(m[2].replace(',', '.')), ngay: globalDate, kho: low.includes('khô') || low.includes('kho') }));
      }
    }
    return rows;
  }

  for (const line of lines) {
    const low = line.toLowerCase();
    if (line.length < 3) continue;
    if (IMP_SKIP_LINE_KEYWORDS.some(k => low.includes(k))) continue;

    if (_impLoai === 'chamcong') {
      // "Tên nhân viên   8"  hoặc  "Tên nhân viên   7.5 giờ"
      const m = line.match(/^([^\d]{3,}?)\s+(\d{1,2}(?:[.,]\d+)?)\s*(?:h|giờ|gio)?\s*$/i);
      if (m) {
        rows.push(impMakeRow({ nhan_vien: m[1].trim(), ngay: globalDate, gio: parseFloat(m[2].replace(',', '.')) }));
      }
      continue;
    }

    // NVL / Hủy Hàng / Chi Phí: tìm [tên] ... [số lượng]? [đvt]? ... [giá/tiền]
    const m = line.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(kg|g|gr|lít|l|ml|hộp|thùng|bó|quả|trái|cái|chai|gói|con|kí)?\s*[xX*]?\s*(\d{1,3}(?:[.,]\d{3})+|\d{4,})\s*(?:đ|vnd|₫)?\s*$/i);
    if (m) {
      const ten = m[1].replace(/[-–.:]+$/, '').trim();
      const sl = parseFloat(m[2].replace(',', '.')) || 1;
      const dvt = m[3] || '';
      const giaOrTong = impMoneyToNumber(m[4]);
      // Nếu số cuối đã lớn hơn nhiều so với sl*10 → khả năng đó là THÀNH TIỀN, suy ra đơn giá
      const gia = giaOrTong / sl > 200 ? giaOrTong / sl : giaOrTong;
      if (_impLoai === 'chiphi') {
        rows.push(impMakeRow({ ten, so_tien: giaOrTong }));
      } else {
        rows.push(impMakeRow({ ngay: globalDate, ten, sl, dvt, gia: Math.round(gia) }));
      }
      continue;
    }

    // Dòng chỉ có [tên] ... [số tiền] — dùng cho Chi Phí hoặc fallback
    const m2 = line.match(/^(.+?)\s+(\d{1,3}(?:[.,]\d{3})+|\d{4,})\s*(?:đ|vnd|₫)?\s*$/i);
    if (m2 && _impLoai === 'chiphi') {
      rows.push(impMakeRow({ ten: m2[1].trim(), so_tien: impMoneyToNumber(m2[2]) }));
    }
  }
  return rows;
}

// ══════════ BẢNG XEM TRƯỚC / SỬA ══════════
function renderImportPreview() {
  const el = document.getElementById('imp-preview');
  if (!el) return;
  if (!_impRows.length) { el.innerHTML = ''; return; }

  if (_impLoai === 'taicho') { renderImportPreviewTaiCho(el); return; }
  if (_impLoai === 'banhang') { renderImportPreviewBanHang(el); return; }

  const nvlOpts = () => sortAZ(S.nvl).map(n => `<option value="${n.ten}">`).join('');
  let head = '', body = '';

  if (_impLoai === 'chamcong') {
    head = `<th>✓</th><th>Nhân Viên (từ file)</th><th>Khớp Với</th><th>Ngày</th><th>Số Giờ</th><th>Nguồn File</th><th></th>`;
    body = _impRows.map((r, i) => {
      const auto = impMatchStaff(r.nhan_vien);
      return `<tr>
        <td><input type="checkbox" ${r._include ? 'checked' : ''} onchange="impRowSet(${i},'_include',this.checked)"></td>
        <td><input value="${r.nhan_vien || ''}" style="width:150px" onchange="impRowSet(${i},'nhan_vien',this.value)"></td>
        <td><select onchange="impRowSetMap(${i},this.value)" style="width:170px">${impMapOptions(S.staff || [], auto, r._mapOverride, '➕ Luôn tạo NV mới')}</select></td>
        <td><input type="date" value="${r.ngay || ''}" onchange="impRowSet(${i},'ngay',this.value)"></td>
        <td><input type="number" step="0.5" value="${r.gio || 0}" style="width:70px" onchange="impRowSet(${i},'gio',parseFloat(this.value)||0)"></td>
        <td class="fs11 txt-gray">${r._source || ''}</td>
        <td><button class="btn btn-outline btn-sm" onclick="impRemoveRow(${i})">🗑</button></td>
      </tr>`;
    }).join('');
  } else if (_impLoai === 'chiphi') {
    head = `<th>✓</th><th>Tên Khoản Chi</th><th>Nhóm</th><th>Loại</th><th>Số Tiền</th><th>Nguồn File</th><th></th>`;
    body = _impRows.map((r, i) => `<tr>
        <td><input type="checkbox" ${r._include ? 'checked' : ''} onchange="impRowSet(${i},'_include',this.checked)"></td>
        <td><input value="${r.ten || ''}" style="width:180px" onchange="impRowSet(${i},'ten',this.value)"></td>
        <td><select onchange="impRowSet(${i},'nhom',this.value)">
          ${['Mặt Bằng', 'Nhân Sự', 'Điện Nước Gas', 'Marketing', 'Vận Hành', 'Khấu Hao', 'Khác'].map(g => `<option ${r.nhom === g ? 'selected' : ''}>${g}</option>`).join('')}
        </select></td>
        <td><select onchange="impRowSet(${i},'loai',this.value)">
          <option value="co_dinh" ${r.loai === 'co_dinh' ? 'selected' : ''}>Cố Định</option>
          <option value="bien_phi" ${r.loai !== 'co_dinh' ? 'selected' : ''}>Biến Phí</option>
        </select></td>
        <td><input type="number" value="${r.so_tien || 0}" style="width:110px" onchange="impRowSet(${i},'so_tien',parseFloat(this.value)||0)"></td>
        <td class="fs11 txt-gray">${r._source || ''}</td>
        <td><button class="btn btn-outline btn-sm" onclick="impRemoveRow(${i})">🗑</button></td>
      </tr>`).join('');
  } else {
    // nvl | huyhang
    const showLyDo = _impLoai === 'huyhang';
    head = `<th>✓</th><th>Ngày</th><th>Tên NVL (từ file)</th><th>Khớp Với</th><th>SL</th><th>ĐVT</th><th>Đơn Giá</th>${showLyDo ? '<th>Lý Do</th>' : ''}<th>Nguồn File</th><th></th>`;
    body = _impRows.map((r, i) => {
      const auto = impMatchNVL(r.ten);
      const resolved = impResolveNVL(r);
      return `<tr>
        <td><input type="checkbox" ${r._include ? 'checked' : ''} onchange="impRowSet(${i},'_include',this.checked)"></td>
        <td><input type="date" value="${r.ngay || ''}" style="width:130px" onchange="impRowSet(${i},'ngay',this.value)"></td>
        <td><input list="imp-nvl-datalist" value="${r.ten || ''}" style="width:160px" onchange="impRowSet(${i},'ten',this.value)"></td>
        <td>
          <select onchange="impRowSetMap(${i},this.value)" style="width:170px">${impMapOptions(S.nvl, auto, r._mapOverride, `➕ Luôn tạo NVL mới (${guessNhomNVL(r.ten)})`)}</select>
          ${resolved ? '' : `<div class="fs11" style="color:var(--amber)">🆕 sẽ tạo NVL mới</div>`}
        </td>
        <td><input type="number" value="${r.sl || 0}" style="width:70px" onchange="impRowSet(${i},'sl',parseFloat(this.value)||0)"></td>
        <td><input value="${r.dvt || resolved?.dvt || ''}" style="width:60px" onchange="impRowSet(${i},'dvt',this.value)"></td>
        <td><input type="number" value="${r.gia || 0}" style="width:100px" onchange="impRowSet(${i},'gia',parseFloat(this.value)||0)"></td>
        ${showLyDo ? `<td><select onchange="impRowSet(${i},'ly_do',this.value)">
          ${['🔥 Hỏng / Hư tự nhiên', '❌ Lỗi chế biến', '⏰ Hết hạn sử dụng', '🍳 Cháy / Quá lửa', '💧 Đổ vỡ / Rò rỉ', '📦 Bao bì hỏng', '❓ Lý do khác'].map(l => `<option ${r.ly_do === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select></td>` : ''}
        <td class="fs11 txt-gray">${r._source || ''}</td>
        <td><button class="btn btn-outline btn-sm" onclick="impRemoveRow(${i})">🗑</button></td>
      </tr>`;
    }).join('');
  }

  el.innerHTML = `
    <datalist id="imp-nvl-datalist">${nvlOpts()}</datalist>
    <div class="alert alert-info mb8 fs12">📋 Tìm được <strong>${_impRows.length}</strong> dòng. Kiểm tra/sửa các ô bên dưới, bỏ tick dòng nào không muốn lưu, rồi bấm <strong>Lưu Tất Cả</strong>.</div>
    ${(_impLoai === 'nvl' || _impLoai === 'huyhang') ? `
    <div class="mb8" style="padding:10px 12px;background:#fff8f0;border:1.5px solid var(--amber, #d97706);border-radius:4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <strong class="fs13">📅 Ngày ${_impLoai === 'nvl' ? 'nhập hàng' : 'hủy'} (áp dụng cho TẤT CẢ ${_impRows.length} dòng bên dưới):</strong>
      <input type="date" value="${_impNgayChung || ''}" onchange="impSetNgayChung(this.value)" style="width:150px;font-weight:600">
      <span class="fs11 txt-gray">Nhiều file hoá đơn không có cột ngày riêng từng dòng — chỉ cần sửa Ở ĐÂY 1 LẦN. Vẫn có thể sửa riêng ở cột "Ngày" cho dòng nào khác ngày.</span>
    </div>` : ''}
    <div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="mt12 flex-center" style="gap:8px">
      <button class="btn btn-teal" onclick="saveAllImportRows()">💾 Lưu Tất Cả Vào Hệ Thống</button>
      <button class="btn btn-outline" onclick="_impRows=[];_impNgayChung='';window._impMonMapOverride={};renderImportPreview();">✖ Xoá Bảng Xem Trước</button>
    </div>`;
}
function impRowSet(i, field, val) {
  if (!_impRows[i]) return;
  _impRows[i][field] = val;
  if (field === '_target') _impRows[i]._mapOverride = undefined; // đổi đích Tại Chỗ/App → reset lựa chọn khớp tay (danh sách món khác nhau)
  if (['ten', 'sl', 'gia', 'mon_ten', '_target', 'nhan_vien'].includes(field)) renderImportPreview();
}
// 📅 Đổi "Ngày bán chung" 1 lần → áp dụng cho TẤT CẢ các dòng Bán Hàng đang xem trước
function impSetNgayChung(val) {
  if (!val) return;
  _impNgayChung = val;
  _impRows.forEach(r => { r.ngay = val; });
  renderImportPreview();
}
function impRemoveRow(i) { _impRows.splice(i, 1); renderImportPreview(); }

// ── 🏠 Xem trước: Chart Món / Công Thức (nhóm theo tên món) ──
function renderImportPreviewTaiCho(el) {
  const nvlOpts = sortAZ(S.nvl).map(n => `<option value="${n.ten}">`).join('');
  const groups = {};
  _impRows.forEach((r, i) => { (groups[r.mon_ten] = groups[r.mon_ten] || []).push(i); });
  if (!window._impMonMapOverride) window._impMonMapOverride = {}; // monTen -> id | 'new' | undefined(auto)

  const body = Object.entries(groups).map(([monTen, idxs]) => {
    const auto = impMatchMonIn(S.menu_taicho, monTen);
    const ov = window._impMonMapOverride[monTen];
    const match = ov === 'new' ? null : (typeof ov === 'number' ? S.menu_taicho.find(m => m.id === ov) : auto);
    const oldCount = match ? (match.nguyen_lieu || []).length : 0;
    const rows = idxs.map(i => {
      const r = _impRows[i];
      const nvlAuto = impMatchNVL(r.ten);
      const nvlResolved = impResolveNVL(r);
      return `<tr>
        <td><input type="checkbox" ${r._include ? 'checked' : ''} onchange="impRowSet(${i},'_include',this.checked)"></td>
        <td><input list="imp-nvl-datalist" value="${r.ten || ''}" style="width:160px" onchange="impRowSet(${i},'ten',this.value)"></td>
        <td><select onchange="impRowSetMap(${i},this.value)" style="width:170px">${impMapOptions(S.nvl, nvlAuto, r._mapOverride, '➕ Luôn tạo NVL mới')}</select>
          ${nvlResolved ? '' : `<div class="fs11" style="color:var(--amber)">🆕 sẽ tạo NVL mới</div>`}
        </td>
        <td><input type="number" value="${r.dinh_luong || 0}" style="width:80px" onchange="impRowSet(${i},'dinh_luong',parseFloat(this.value)||0)"></td>
        <td><input value="${r.dvt || nvlResolved?.dvt || ''}" style="width:70px" onchange="impRowSet(${i},'dvt',this.value)"></td>
        <td><button class="btn btn-outline btn-sm" onclick="impRemoveRow(${i})">🗑</button></td>
      </tr>`;
    }).join('');
    const monSelectOpts = [
      `<option value="__auto__" ${ov === undefined ? 'selected' : ''}>🔎 Tự động (${auto ? '✅ ' + auto.ten : '🆕 tạo món mới'})</option>`,
      `<option value="__new__" ${ov === 'new' ? 'selected' : ''}>➕ Luôn tạo món mới</option>`,
      ...sortAZ(S.menu_taicho).map(m => `<option value="${m.id}" ${ov === m.id ? 'selected' : ''}>${m.ten}</option>`)
    ].join('');
    return `<div class="mb12" style="border:1.5px solid var(--border);border-radius:4px;overflow:hidden">
      <div style="padding:8px 12px;background:${match ? '#fff8f0' : '#f0fdf4'};display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <strong>${monTen}</strong>
        <span class="fs11">Khớp Với: <select onchange="_impMonMapOverride['${monTen.replace(/'/g, "\\'")}']=this.value==='__auto__'?undefined:(this.value==='__new__'?'new':parseInt(this.value));renderImportPreview();">${monSelectOpts}</select></span>
        <span class="fs11">${match ? `⚠️ Món đã có trong Menu Tại Chỗ — sẽ <strong>THAY THẾ</strong> công thức cũ (${oldCount} nguyên liệu → ${idxs.length} nguyên liệu mới)` : `🆕 Món mới — sẽ tạo trong Menu Tại Chỗ`}</span>
      </div>
      <div class="tbl-wrap"><table><thead><tr><th>✓</th><th>Tên NVL</th><th>Khớp Với</th><th>Định Lượng</th><th>ĐVT</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <datalist id="imp-nvl-datalist">${nvlOpts}</datalist>
    <div class="alert alert-info mb8 fs12">📋 Tìm được công thức cho <strong>${Object.keys(groups).length}</strong> món (${_impRows.length} dòng nguyên liệu). Kiểm tra kỹ định lượng trước khi lưu — mỗi món khớp tên có sẵn sẽ bị GHI ĐÈ công thức cũ.</div>
    ${body}
    <div class="mt12 flex-center" style="gap:8px">
      <button class="btn btn-teal" onclick="saveAllImportRows()">💾 Lưu Tất Cả Vào Hệ Thống</button>
      <button class="btn btn-outline" onclick="_impRows=[];window._impMonMapOverride={};renderImportPreview();">✖ Xoá Bảng Xem Trước</button>
    </div>`;
}

// ── 🛒 Xem trước: Báo Cáo Bán Hàng (tự dò khớp món ở Tại Chỗ / App / Combo, có nhớ sổ tay) ──
function renderImportPreviewBanHang(el) {
  if (!S.import_ten_alias) S.import_ten_alias = {};
  const allMonOpts = sortAZ([...S.menu.map(m => m.ten), ...S.menu_taicho.map(m => m.ten), ...(S.combos || []).map(c => c.ten)].filter((v, i, a) => a.indexOf(v) === i).map(ten => ({ ten }))).map(m => `<option value="${m.ten}">`).join('');
  const targetLabels = { taicho: 'Menu Tại Chỗ', menu: 'Bán Hàng (App)', combo: 'Combo' };
  const body = _impRows.map((r, i) => {
    if (r._target === undefined) {
      const det = impAutoDetectTarget(r.mon_ten);
      r._target = det ? det.target : 'skip';
    }
    const candList = r._target === 'taicho' ? S.menu_taicho : r._target === 'menu' ? S.menu : r._target === 'combo' ? (S.combos || []) : [];
    const auto = r._target === 'combo' ? impMatchMonIn(S.combos || [], r.mon_ten) : r._target === 'taicho' ? impMatchMonIn(S.menu_taicho, r.mon_ten) : r._target === 'menu' ? impMatchMonIn(S.menu, r.mon_ten) : null;
    const resolved = impResolveMonIn(candList, r, 'mon_ten');
    const matchLabel = resolved ? `✅ Khớp: ${resolved.ten}` : `🆕 Món mới — sẽ tạo trong ${targetLabels[r._target] || '(chưa chọn đích)'}`;
    return `<tr>
      <td><input type="checkbox" ${r._include ? 'checked' : ''} onchange="impRowSet(${i},'_include',this.checked)"></td>
      <td><input list="imp-mon-datalist" value="${r.mon_ten || ''}" style="width:170px" onchange="impRowSet(${i},'mon_ten',this.value)"></td>
      <td>
        <select onchange="impRowSetMonMap(${i},this.value)" style="width:170px" ${candList.length ? '' : 'disabled'}>${impMapOptions(candList, auto, r._mapOverride, r._target === 'combo' ? '⛔ Không tự tạo Combo mới — chọn combo có sẵn' : '➕ Luôn tạo món mới')}</select>
        <div class="fs11 txt-gray">${matchLabel}</div>
      </td>
      <td><select onchange="impRowSet(${i},'_target',this.value)">
        <option value="taicho" ${r._target === 'taicho' ? 'selected' : ''}>🏠 Menu Tại Chỗ</option>
        <option value="menu" ${r._target === 'menu' ? 'selected' : ''}>🛒 Bán Hàng (App)</option>
        <option value="combo" ${r._target === 'combo' ? 'selected' : ''}>🔗 Combo</option>
        <option value="skip" ${r._target === 'skip' ? 'selected' : ''}>⛔ Bỏ qua dòng này</option>
      </select></td>
      <td><input type="date" value="${r.ngay || ''}" style="width:130px" onchange="impRowSet(${i},'ngay',this.value)"></td>
      <td><input type="number" value="${r.sl || 0}" style="width:70px" onchange="impRowSet(${i},'sl',parseFloat(this.value)||0)"></td>
      <td><input type="checkbox" ${r.kho ? 'checked' : ''} onchange="impRowSet(${i},'kho',this.checked)" title="Món khô (vd hủ tiếu khô)"></td>
      <td class="fs11 txt-gray">${r._source || ''}</td>
      <td><button class="btn btn-outline btn-sm" onclick="impRemoveRow(${i})">🗑</button></td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <datalist id="imp-mon-datalist">${allMonOpts}</datalist>
    <div class="alert alert-info mb8 fs12">📋 Tìm được <strong>${_impRows.length}</strong> dòng bán hàng. Hệ thống tự dò khớp món ở Menu Tại Chỗ, Bán Hàng (App) và Combo — kiểm tra cột "Khớp Với" (chọn tay nếu chưa đúng) và "Lưu Vào", số lượng của các dòng TRÙNG món + trùng ngày sẽ được <strong>CỘNG DỒN</strong> vào số đã có sẵn trong ngày đó (không ghi đè mất số cũ). 🔗 Mỗi lần bạn chọn tay 1 tên trong "Khớp Với", hệ thống sẽ <strong>ghi nhớ</strong> tên đó cho lần import sau (kể cả tên trong file POS khác hẳn tên trong hệ thống).</div>
    <div class="mb8" style="padding:10px 12px;background:#fff8f0;border:1.5px solid var(--amber, #d97706);border-radius:4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <strong class="fs13">📅 Ngày bán (áp dụng cho TẤT CẢ ${_impRows.length} dòng bên dưới):</strong>
      <input type="date" value="${_impNgayChung || ''}" onchange="impSetNgayChung(this.value)" style="width:150px;font-weight:600">
      <span class="fs11 txt-gray">Báo cáo bán hàng thường không có cột ngày riêng từng dòng — chỉ cần sửa Ở ĐÂY 1 LẦN, không cần sửa từng dòng. Vẫn có thể sửa riêng ở cột "Ngày" cho dòng nào khác ngày.</span>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>✓</th><th>Tên Món (từ file)</th><th>Khớp Với</th><th>Lưu Vào</th><th>Ngày</th><th>SL Bán</th><th>Khô?</th><th>Nguồn File</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="mt12 flex-center" style="gap:8px">
      <button class="btn btn-teal" onclick="saveAllImportRows()">💾 Lưu Tất Cả Vào Hệ Thống</button>
      <button class="btn btn-outline" onclick="_impRows=[];_impNgayChung='';window._impMonMapOverride={};renderImportPreview();">✖ Xoá Bảng Xem Trước</button>
    </div>`;
}

// ══════════ LƯU VÀO HỆ THỐNG ══════════
function saveAllImportRows() {
  const rows = _impRows.filter(r => r._include);
  if (!rows.length) { alert('Không có dòng nào được chọn để lưu!'); return; }
  let added = 0;
  let skippedComboMoi = 0;

  if (_impLoai === 'nvl' || _impLoai === 'huyhang') {
    rows.forEach(r => {
      if (!r.ten || !r.ngay) return;
      let nvl = impResolveNVL(r);
      if (!nvl) {
        const newId = Math.max(0, ...S.nvl.map(n => n.id)) + 1;
        nvl = { id: newId, ten: r.ten.trim(), dvt: r.dvt || 'kg', gia: r.gia || 0, gia_chuan: r.gia || 0, gia_chuan_ngay: new Date().toISOString().slice(0, 10), gia_chuan_auto: false, nhom: guessNhomNVL(r.ten), khong_quan_ly_ton: false };
        S.nvl.push(nvl);
      }
      const thang = parseInt(r.ngay.split('-')[1]), nam = parseInt(r.ngay.split('-')[0]);
      const mk = mkey(thang, nam);
      if (_impLoai === 'nvl') {
        if (!S.inventory) S.inventory = {};
        if (!S.inventory[mk]) S.inventory[mk] = [];
        const giaChuan = nvl.gia_chuan || nvl.gia || 0;
        const pct = giaChuan > 0 && r.gia > 0 ? (r.gia - giaChuan) / giaChuan : 0;
        S.inventory[mk].push({
          id: Date.now() + added, date: r.ngay, ten: nvl.ten, dvt: r.dvt || nvl.dvt, sl: r.sl || 0,
          don_gia: r.gia || 0, thanh_tien: (r.sl || 0) * (r.gia || 0), nhom: nvl.nhom,
          ghichu: `Import tự động${r._nha_cung_cap ? ' — NCC: ' + r._nha_cung_cap : ''} (${r._source || ''})`, gia_chuan_ref: giaChuan, pct_vs_chuan: pct,
          warn_level: pct > 0 ? (getPriceWarnLevel(pct)?.label || null) : null, tu_import: true
        });
        if (r.gia > 0) nvl.gia = r.gia;
      } else {
        if (!S.huy_hang) S.huy_hang = {};
        if (!S.huy_hang[mk]) S.huy_hang[mk] = [];
        S.huy_hang[mk].push({
          ngay: r.ngay, ten: nvl.ten, dvt: r.dvt || nvl.dvt, sl: r.sl || 0,
          gia: r.gia || nvl.gia || 0, thanh_tien: (r.sl || 0) * (r.gia || nvl.gia || 0),
          ly_do: r.ly_do || '❓ Lý do khác', nguoi: '', tu_import: true
        });
      }
      added++;
    });
    if (_impLoai === 'nvl' && typeof autoUpdateGiaChuan === 'function') autoUpdateGiaChuan();
  } else if (_impLoai === 'chiphi') {
    rows.forEach(r => {
      if (!r.ten || !r.so_tien) return;
      S.chi_phi.push({ ten: r.ten.trim(), nhom: r.nhom || 'Khác', loai: r.loai || 'bien_phi', so_tien: r.so_tien, thang: S.thang, nam: S.nam });
      added++;
    });
  } else if (_impLoai === 'chamcong') {
    rows.forEach(r => {
      if (!r.nhan_vien) return;
      let nv = impResolveStaff(r);
      if (!nv) {
        const newId = Math.max(0, ...(S.staff || []).map(n => n.id), 0) + 1;
        nv = { id: newId, ten: r.nhan_vien.trim(), chuc_vu: '', luong_gio: 0, luong_ngay: 0 };
        if (!S.staff) S.staff = [];
        S.staff.push(nv);
      }
      let ngay = r.ngay, dayNum = r.ngay_so;
      if (!dayNum && ngay) dayNum = parseInt(ngay.split('-')[2]);
      const thang = ngay ? parseInt(ngay.split('-')[1]) : S.thang;
      const nam = ngay ? parseInt(ngay.split('-')[0]) : S.nam;
      if (!dayNum) return;
      const mk = mkey(thang, nam);
      const key = `${mk}-${nv.id}`;
      if (!S.cham_cong) S.cham_cong = {};
      if (!S.cham_cong[key]) S.cham_cong[key] = new Array(31).fill(0);
      S.cham_cong[key][dayNum - 1] = r.gio || 0;
      added++;
    });
  } else if (_impLoai === 'taicho') {
    // Gom các dòng nguyên liệu theo tên món → mỗi món ghi/cập nhật 1 công thức
    const groups = {};
    rows.forEach(r => { if (r.mon_ten) (groups[r.mon_ten] = groups[r.mon_ten] || []).push(r); });
    Object.entries(groups).forEach(([monTen, ingrRows]) => {
      const nguyenLieu = ingrRows.filter(r => r.ten).map(r => {
        let nvl = impResolveNVL(r);
        if (!nvl) {
          const newId = Math.max(0, ...S.nvl.map(n => n.id), 0) + 1;
          nvl = { id: newId, ten: r.ten.trim(), dvt: r.dvt || 'kg', gia: 0, gia_chuan: 0, gia_chuan_ngay: new Date().toISOString().slice(0, 10), gia_chuan_auto: false, nhom: guessNhomNVL(r.ten), khong_quan_ly_ton: false };
          S.nvl.push(nvl);
        }
        return { ten: nvl.ten, dvt_nvl: r.dvt || nvl.dvt, dinh_luong: r.dinh_luong || 0 };
      });
      if (!nguyenLieu.length) return;
      const monOv = (window._impMonMapOverride || {})[monTen];
      let mon = monOv === 'new' ? null : (typeof monOv === 'number' ? S.menu_taicho.find(m => m.id === monOv) : impMatchMonIn(S.menu_taicho, monTen));
      if (mon) {
        mon.nguyen_lieu = nguyenLieu; // [FIX-safe] mutate object tìm theo tên/ID, không đụng tới index mảng
      } else {
        if (!S.menu_taicho) S.menu_taicho = [];
        const newId = Math.max(0, ...S.menu_taicho.map(m => m.id), ...S.menu.map(m => m.id), 0) + 1;
        S.menu_taicho.push({ id: newId, ten: monTen.trim(), gia_ban: 0, pct_san: 0, pct_mkt: 0, nhom_mon: (typeof getMonNhom === 'function' ? getMonNhom(monTen) : ''), nguyen_lieu: nguyenLieu });
      }
      added++;
    });
    if (typeof ensureNVLForIngredients === 'function') ensureNVLForIngredients();
    if (typeof syncNVLHaoHut === 'function') syncNVLHaoHut();
  } else if (_impLoai === 'banhang') {
    if (!S.ban_hang) S.ban_hang = {};
    if (!S.import_ten_alias) S.import_ten_alias = {};
    // 🔗 CỘNG DỒN: nhiều dòng đơn hàng trong CÙNG lượt import trùng món+ngày+đích được gộp lại
    // trước, sau đó cộng thêm vào số đã có sẵn trong hệ thống — không dòng nào bị ghi đè mất.
    const batchAgg = {}; // "mk|key|day" -> tổng SL cộng thêm của lượt import này
    rows.forEach(r => {
      if (r._target === 'skip' || !r.mon_ten || !r.sl) return;
      const ngay = r.ngay || new Date().toISOString().slice(0, 10);
      const parts = ngay.split('-');
      const nam = parseInt(parts[0]), thang = parseInt(parts[1]), day = parseInt(parts[2]);
      if (!day) return;
      const list = r._target === 'taicho' ? S.menu_taicho : r._target === 'combo' ? (S.combos || []) : S.menu;
      let mon = impResolveMonIn(list, r, 'mon_ten');
      if (!mon) {
        if (r._target === 'combo') { skippedComboMoi++; return; } // Combo cần chọn ĐÚNG combo có sẵn (có mon_ids + giá) — không tự tạo combo rỗng từ báo cáo bán hàng
        if (r._mapOverride !== 'new') return; // Chưa khớp món & chưa chọn tay "Luôn tạo món mới" → bỏ qua, không tự ý tạo món từ báo cáo bán hàng
        const newId = Math.max(0, ...S.menu.map(m => m.id), ...S.menu_taicho.map(m => m.id), 0) + 1;
        mon = { id: newId, ten: r.mon_ten.trim(), gia_ban: 0, pct_san: 0, pct_mkt: 0, nhom_mon: (typeof getMonNhom === 'function' ? getMonNhom(r.mon_ten) : '') };
        if (r._target === 'taicho') { mon.nguyen_lieu = []; if (!S.menu_taicho) S.menu_taicho = []; S.menu_taicho.push(mon); }
        else { if (!S.menu) S.menu = []; S.menu.push(mon); }
      }
      // 🔗 Món/combo này đã khớp được với 1 mục có sẵn trong hệ thống → ghi nhớ tên (từ file POS)
      // vào sổ tay, để lần import sau (kể cả không chọn tay) vẫn tự nhận diện được ngay.
      impAliasSave(r.mon_ten, r._target, mon.id);
      const mk = mkey(thang, nam);
      let key = r._target === 'taicho' ? 'tc_' + mon.id : r._target === 'combo' ? 'c_' + mon.id : String(mon.id);
      if (r.kho) key += '_kho';
      const aggKey = `${mk}|${key}|${day}`;
      batchAgg[aggKey] = (batchAgg[aggKey] || 0) + r.sl;
    });
    Object.entries(batchAgg).forEach(([aggKey, sumSl]) => {
      const [mk, key, dayStr] = aggKey.split('|');
      if (!S.ban_hang[mk]) S.ban_hang[mk] = {};
      if (!S.ban_hang[mk][key]) S.ban_hang[mk][key] = {};
      const daDaCo = S.ban_hang[mk][key][dayStr] || 0;
      S.ban_hang[mk][key][dayStr] = daDaCo + sumSl; // cộng dồn, không ghi đè
      added++;
    });
  }

  saveData();
  _impRows = [];
  window._impMonMapOverride = {};
  renderImportPreview();
  const statusEl = document.getElementById('imp-status');
  if (statusEl) {
    let msg = `✅ Đã lưu ${added} dòng vào hệ thống! Vào tab tương ứng để kiểm tra.`;
    if (skippedComboMoi > 0) {
      msg += ` ⚠️ ${skippedComboMoi} dòng chọn "Combo" nhưng chưa khớp được combo có sẵn nên đã BỎ QUA (chưa lưu) — vào cột "Khớp Với" chọn đúng combo, hoặc đổi "Lưu Vào" sang Menu Tại Chỗ/App nếu đây thực ra là món lẻ.`;
    }
    statusEl.textContent = msg;
  }
  // Cập nhật lại tab đích nếu đang mở sẵn ở tab khác
  if (document.getElementById('page-inventory')?.classList.contains('on') && typeof renderInventory === 'function') renderInventory();
  if (document.getElementById('page-huyhang')?.classList.contains('on') && typeof renderHuyHang === 'function') renderHuyHang();
  if (document.getElementById('page-chiphi')?.classList.contains('on') && typeof renderChiPhi === 'function') renderChiPhi();
  if (document.getElementById('page-chamcong')?.classList.contains('on') && typeof renderChamCong === 'function') renderChamCong();
  if (document.getElementById('page-nvl')?.classList.contains('on') && typeof renderNVL === 'function') renderNVL();
  if (document.getElementById('page-bantaicho')?.classList.contains('on') && typeof renderTaiCho === 'function') renderTaiCho();
  if (document.getElementById('page-menu')?.classList.contains('on') && typeof renderMenu === 'function') renderMenu();
  if (document.getElementById('page-banhang')?.classList.contains('on') && typeof renderBanHang === 'function') renderBanHang();
  if (typeof renderDashboard === 'function') renderDashboard();
  if (typeof refreshNVLDatalist === 'function') refreshNVLDatalist();
}

function renderImport() {
  const sel = document.getElementById('imp-loai');
  if (sel) _impLoai = sel.value;
  onImportLoaiChange();
}
