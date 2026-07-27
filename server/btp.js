// server/btp.js  (PHIÊN BẢN 3)
//
// Thay đổi so với bản 2, theo đúng file mẫu (.xlsx + .html) bạn gửi:
//
// 1. CÔNG THỨC BTP: mỗi nguyên liệu trong công thức nhập ĐỊNH LƯỢNG CHO CẢ
//    MẺ (không phải cho 1kg) — giống hệt cách bạn đã làm trong file Excel
//    mẫu (vd: món "Btp-Heo Xào 2kg" có dòng "Thịt xay: 2000" nghĩa là dùng
//    2000g/2kg thịt xay CHO CẢ MẺ 2kg đó).
//
// 2. "SẢN XUẤT 1 MẺ": bạn nhập SỐ KG (hoặc lít...) THỰC TẾ mẻ đó ra được
//    (có thể khác số danh nghĩa trong công thức do hao hụt thực tế khi nấu)
//    — đúng như cách file .html mẫu tính: costPerUnit = tổng giá vốn NVL
//    của mẻ ÷ số lượng thành phẩm thực tế.
//
// 3. TỰ ĐỘNG CẬP NHẬT GIÁ NVL: costPerUnit tính ra được GHI THẲNG vào danh
//    mục NVL dùng chung (data.nvl) ở đúng dòng tên BTP đó (nếu chưa có dòng
//    nào tên này trong NVL, tự tạo mới, nhóm "BTP"). Nhờ vậy khi bạn lên
//    công thức món ăn hoàn chỉnh dùng BTP này, giá vốn món ăn luôn tính
//    đúng theo giá BTP mới nhất — và khi bán món đó, hệ thống tự trừ đúng
//    từ nguồn NVL (đã bao gồm BTP) theo công thức món, không cần làm gì
//    thêm ở tab Bán Hàng.
//
// 4. MẬT KHẨU FILE BTP có 2 cấp:
//    - Đổi bình thường (nút trong chính file BTP): BẮT BUỘC nhập đúng mật
//      khẩu CŨ mới cho đổi — endpoint `/change-branch-password`.
//    - Super Admin (theo SUPERADMIN_USERNAME trong Environment Variables):
//      đổi được KHÔNG CẦN mật khẩu cũ — endpoint `/secure-update` (giữ như
//      bản trước).

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { requireAuth, requireSuperAdmin } = require('./auth');
const { reconcileBtpNvl, markBtpGiaSanXuat } = require('./btp-nvl-sync');

const VALID_BRANCHES = ['khapkhun'];
function validBranch(b) { return VALID_BRANCHES.includes(b); }

function mkey(thang, nam) {
  return `${nam}-${String(thang).padStart(2, '0')}`;
}

// Chuẩn hoá tên để so khớp NVL/BTP không phân biệt hoa/thường và khoảng
// trắng thừa — QUAN TRỌNG: đây là chỗ trước đây so khớp tuyệt đối
// (n.ten === recipe.name) khiến giá BTP sau khi "Sản Xuất Mẻ" bị ghi vào
// một dòng NVL mới, KHÔNG PHẢI dòng NVL mà Menu/Menu Tại Chỗ đang thực sự
// tham chiếu (chỉ vì lệch 1 khoảng trắng hoặc hoa/thường) — làm giá vốn
// món ăn không bao giờ được cập nhật đúng.
function normName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Loại NVL theo ĐVT: 'mass' = kg/lít (nhập theo gram/ml, chia 1000 để ra
// đơn vị kho), 'count' = đếm nguyên (cái/trái/miếng/gói/chai/bịch...)
function unitType(dvt) {
  const u = (dvt || '').trim().toLowerCase();
  return (u === 'kg' || u === 'lít' || u === 'lit' || u === 'l') ? 'mass' : 'count';
}

// Quy đổi định lượng nhập trong công thức (g/ml hoặc số cái) -> đơn vị kho
function qtyInStockUnit(ing, nvlItem) {
  const t = nvlItem ? unitType(nvlItem.dvt) : 'mass';
  const qty = Number(ing.qty) || 0;
  return t === 'mass' ? qty / 1000 : qty;
}

// Thành tiền 1 dòng nguyên liệu (đã gồm % hao hụt)
function ingCost(ing, nvlItem) {
  const price = nvlItem ? (Number(nvlItem.gia) || 0) : 0;
  return qtyInStockUnit(ing, nvlItem) * price * (1 + (Number(ing.waste) || 0));
}

// Tính giá vốn cả mẻ theo công thức (dùng giá NVL hiện tại trong data.nvl)
function calcRecipeCost(recipe, nvlList) {
  let totalNvl = 0;
  const missing = [];
  for (const ing of (recipe.ingredients || [])) {
    const nvlItem = nvlList.find(n => normName(n.ten) === normName(ing.ten));
    if (!nvlItem) { missing.push(ing.ten); continue; }
    totalNvl += ingCost({ qty: ing.dinh_luong, waste: ing.hao_hut }, { dvt: nvlItem.dvt, gia: nvlItem.gia });
  }
  return { totalNvl, missing };
}

module.exports = function (io) {
  const router = express.Router();

  async function loadState(client) {
    const { rows } = await client.query('SELECT data FROM app_state WHERE id = 1 FOR UPDATE');
    if (rows.length === 0) return {};
    const raw = rows[0].data;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  }

  async function saveState(client, data, updatedBy, senderSocketId) {
    // Chốt chặn cuối cùng: dù route nào gọi saveState, luôn đảm bảo Nhóm BTP
    // trong NVL khớp đúng data.btp_recipes trước khi ghi xuống DB.
    if (reconcileBtpNvl(data)) {
      console.log('🍲 [btp.js saveState] Đã tự đồng bộ lại Nhóm BTP trong NVL.');
    }
    const { rows } = await client.query(
      `UPDATE app_state SET data = $1, updated_at = now(), updated_by = $2 WHERE id = 1 RETURNING updated_at`,
      [JSON.stringify(data), updatedBy]
    );
    const updated_at = rows[0]?.updated_at;
    io.sockets.sockets.forEach((s) => {
      if (s.id !== senderSocketId) {
        s.emit('state-updated', { data, updated_at, updated_by: updatedBy });
      }
    });
    return updated_at;
  }

  // =====================================================================
  // A. MẬT KHẨU FILE BTP
  // =====================================================================

  // Kiểm tra mật khẩu để MỞ file BTP (không đổi gì)
  router.post('/secure-check', requireAuth, async (req, res) => {
    const { branch, password } = req.body;
    if (!validBranch(branch)) {
      return res.status(400).json({ success: false, message: 'Chi nhánh không hợp lệ!' });
    }
    try {
      const { rows } = await pool.query(
        'SELECT password_hash FROM btp_branch_auth WHERE branch = $1', [branch]
      );
      if (rows.length === 0) {
        return res.json({ success: false, message: 'Chưa cấu hình mật khẩu cho chi nhánh này! Vào mục Super Admin để đặt.' });
      }
      const ok = await bcrypt.compare(password || '', rows[0].password_hash);
      if (!ok) return res.json({ success: false, message: 'Mật khẩu không chính xác!' });
      res.json({ success: true, message: 'Xác thực thành công!' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Đổi mật khẩu BÌNH THƯỜNG — nút "Đổi mật khẩu" bên trong chính file BTP.
  // BẮT BUỘC nhập đúng mật khẩu CŨ. Ai đã đăng nhập app đều gọi được (không
  // cần quyền Admin) — vì mật khẩu chi nhánh vốn không gắn với 1 người cụ
  // thể, chỉ cần biết đúng mật khẩu cũ là được xem như "người có quyền" đổi.
  router.post('/change-branch-password', requireAuth, async (req, res) => {
    const { branch, old_password, new_password } = req.body;
    if (!validBranch(branch)) {
      return res.status(400).json({ success: false, message: 'Chi nhánh không hợp lệ!' });
    }
    if (!new_password || new_password.length < 4) {
      return res.status(400).json({ success: false, message: 'Mật khẩu mới phải từ 4 ký tự trở lên' });
    }
    try {
      const { rows } = await pool.query(
        'SELECT password_hash FROM btp_branch_auth WHERE branch = $1', [branch]
      );
      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Chưa cấu hình mật khẩu cho chi nhánh này!' });
      }
      const ok = await bcrypt.compare(old_password || '', rows[0].password_hash);
      if (!ok) {
        return res.status(401).json({ success: false, message: 'Mật khẩu cũ không đúng — không thể đổi!' });
      }
      const newHash = await bcrypt.hash(new_password, 10);
      await pool.query(
        'UPDATE btp_branch_auth SET password_hash = $1, updated_at = now(), updated_by = $2 WHERE branch = $3',
        [newHash, req.user.name, branch]
      );
      res.json({ success: true, message: 'Đã đổi mật khẩu file BTP thành công!' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Đổi mật khẩu KHÔNG CẦN mật khẩu cũ — CHỈ Super Admin (theo
  // SUPERADMIN_USERNAME trong Environment Variables) mới gọi được, nhờ
  // middleware requireSuperAdmin kiểm tra req.user.is_superadmin.
  router.post('/secure-update', requireAuth, requireSuperAdmin, async (req, res) => {
    const { passKhapKhun } = req.body;
    try {
      if (passKhapKhun && passKhapKhun.trim()) {
        const hash = await bcrypt.hash(passKhapKhun.trim(), 10);
        await pool.query(
          `INSERT INTO btp_branch_auth (branch, password_hash, updated_by)
           VALUES ('khapkhun', $1, $2)
           ON CONFLICT (branch) DO UPDATE SET password_hash = $1, updated_at = now(), updated_by = $2`,
          [hash, req.user.name]
        );
      }
      res.json({ success: true, message: 'Super Admin đã đặt mật khẩu file BTP mới (không cần mật khẩu cũ)!' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // =====================================================================
  // B. CÔNG THỨC BTP THEO TỪNG CHI NHÁNH
  //    data.btp_recipes = { khapkhun: [ {id, name, output_qty, output_unit,
  //      ingredients: [{ten, dinh_luong, hao_hut}]} ] }
  //    "dinh_luong" = định lượng CHO CẢ MẺ, tính theo gam (NVL loại kg/lít)
  //    hoặc theo số nguyên (NVL loại đếm cái/gói/...), giống hệt file mẫu.
  // =====================================================================

  router.get('/recipes', requireAuth, async (req, res) => {
    const { branch } = req.query;
    if (!validBranch(branch)) {
      return res.status(400).json({ success: false, message: 'Chi nhánh không hợp lệ!' });
    }
    try {
      const { rows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
      const raw = rows[0]?.data;
      const data = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      const list = data.btp_recipes?.[branch] || [];
      // Tính kèm giá vốn hiện tại (theo giá NVL mới nhất) để hiển thị preview
      const withCost = list.map(r => {
        const { totalNvl, missing } = calcRecipeCost(r, data.nvl || []);
        const perUnit = r.output_qty > 0 ? totalNvl / r.output_qty : 0;
        return { ...r, _totalNvl: totalNvl, _perUnit: perUnit, _missingNvl: missing };
      });
      res.json({ success: true, dishes: withCost });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  router.post('/save-dish', requireAuth, async (req, res) => {
  const { branch, dish } = req.body;
  if (!validBranch(branch)) {
    return res.status(400).json({ success: false, message: 'Chi nhánh không hợp lệ!' });
  }
  if (!dish || !dish.name || !dish.output_qty || !dish.output_unit) {
    return res.status(400).json({ success: false, message: 'Thiếu tên món / số lượng ra mẻ (danh nghĩa) / đơn vị' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const data = await loadState(client);
    if (!data.btp_recipes) data.btp_recipes = { khapkhun: [] };
    if (!data.btp_recipes[branch]) data.btp_recipes[branch] = [];
    if (!Array.isArray(data.nvl)) data.nvl = [];

    if (Array.isArray(dish?.ingredients)) {
      for (const ing of dish.ingredients) {
        if (!ing || !ing.ten) continue;
        const key = normName(ing.ten);
        if (!data.nvl.some(n => normName(n.ten) === key)) {
          const maxIdNvl = Math.max(0, ...data.nvl.map(n => n.id || 0));
          data.nvl.push({ id: maxIdNvl + 1, ten: ing.ten, dvt: 'kg', gia: 0, nhom: ' Nhóm Hàng Khô' }); 
        }
      }
    }

    // --- ĐOẠN ĐÃ SỬA: PHÁ BỎ BIA MỘ ---
    if (data.btp_recipes_deleted?.[branch]) {
      const currentKey = normName(dish.name);
      if (data.btp_recipes_deleted[branch].includes(currentKey)) {
        data.btp_recipes_deleted[branch] = data.btp_recipes_deleted[branch].filter(
          nameKey => nameKey !== currentKey
        );
        console.log(`[Hồi sinh BTP] Đã xóa "${dish.name}" khỏi danh sách btp_recipes_deleted.`);
      }
    }

    const list = data.btp_recipes[branch];
    let oldName = null;
    
    if (dish.id) {
      const idx = list.findIndex(d => d.id === dish.id);
      if (idx >= 0) { 
        oldName = list[idx].name; 
        list[idx] = { ...list[idx], ...dish }; 
      } else {
        list.push(dish);
      }
    } else {
      const maxId = Math.max(0, ...list.map(d => d.id || 0));
      dish.id = maxId + 1;
      list.push(dish);
    }

    if (dish.name) {
      const newNameKey = normName(dish.name);
      if (data.btp_recipes_deleted?.[branch]?.includes(newNameKey)) {
        data.btp_recipes_deleted[branch] = data.btp_recipes_deleted[branch].filter(
          nameKey => nameKey !== newNameKey
        );
      }
    }

    if (oldName && normName(oldName) !== normName(dish.name)) {
      const oldNvl = data.nvl.find(n => normName(n.ten) === normName(oldName));
      const conflictNvl = data.nvl.find(n => normName(n.ten) === normName(dish.name));
      if (oldNvl && !conflictNvl) oldNvl.ten = dish.name;
    }
    // --- HẾT ĐOẠN PHÁ BỎ BIA MỘ ---

    await saveState(client, data, req.user.name, req.headers['x-socket-id']);
    await client.query('COMMIT');
    res.json({ success: true, message: 'Đã lưu công thức BTP!', dish });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: e.message });
  } finally {
    client.release();
  }
});


 router.delete('/dish/:id', requireAuth, async (req, res) => {
    const { branch } = req.query;
    if (!validBranch(branch)) {
      return res.status(400).json({ success: false, message: 'Chi nhánh không hợp lệ!' });
    }
    const id = parseInt(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const data = await loadState(client);
      if (data.btp_recipes?.[branch]) {
        // Ghi "bia mộ" TRƯỚC khi xóa, để lần server khởi động lại tiếp theo,
        // seedBtpRecipes() (server/db.js) KHÔNG tự thêm lại đúng món vừa xóa
        // cho đúng chi nhánh này — 2 file BTP giờ tách biệt thật sự.
        const dishBiXoa = data.btp_recipes[branch].find(d => d.id === id);
        if (dishBiXoa) {
          if (!data.btp_recipes_deleted) data.btp_recipes_deleted = { khapkhun: [] };
          if (!Array.isArray(data.btp_recipes_deleted[branch])) data.btp_recipes_deleted[branch] = [];
          const key = normName(dishBiXoa.name);
          if (!data.btp_recipes_deleted[branch].includes(key)) {
            data.btp_recipes_deleted[branch].push(key);
          }
        }
        data.btp_recipes[branch] = data.btp_recipes[branch].filter(d => d.id !== id);
      }
      // saveState() sẽ tự đưa dòng NVL tương ứng ra khỏi "🍲 Nhóm BTP" (nếu
      // không còn chi nhánh nào dùng tên món này nữa) thông qua
      // reconcileBtpNvl() — không xoá NVL, chỉ đổi nhóm, giữ nguyên giá vốn
      // Menu đã tính trước đó.
      await saveState(client, data, req.user.name, req.headers['x-socket-id']);
      await client.query('COMMIT');
      res.json({ success: true, message: 'Đã xóa công thức BTP' });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, message: e.message });
    } finally {
      client.release();
    }
  });

  // =====================================================================
  // C. "SẢN XUẤT 1 MẺ" — nhập SỐ LƯỢNG THỰC TẾ mẻ đó ra được, hệ thống:
  //    1. Tính tổng giá vốn NVL của mẻ theo đúng công thức (giá NVL hiện tại)
  //    2. costPerUnit = tổng giá vốn ÷ số lượng thực tế -> quy về giá/1kg
  //       (hoặc /1 lít, /1 cái... tuỳ output_unit của món)
  //    3. GHI THẲNG costPerUnit vào data.nvl (dòng tên đúng bằng tên món
  //       BTP) — nếu chưa có dòng NVL tên này, tự tạo mới, nhóm "BTP"
  //    4. Trừ NVL thô đã dùng (theo đúng công thức, không nhân hệ số gì
  //       thêm — vì đây LÀ đúng 1 mẻ theo công thức đã nhập)
  //    5. Nhập kho đúng SỐ LƯỢNG THỰC TẾ của BTP vào data.inventory[mk]
  //    KHÔNG ghi doanh thu — đây là sản xuất nội bộ, không bán cho khách.
  // =====================================================================

  router.post('/produce', requireAuth, async (req, res) => {
    const { branch, dish_id, actual_output_qty, thang, nam } = req.body;
    if (!validBranch(branch)) {
      return res.status(400).json({ success: false, message: 'Chi nhánh không hợp lệ!' });
    }
    const actualQty = parseFloat(actual_output_qty || 0);
    if (!dish_id || !actualQty || actualQty <= 0) {
      return res.status(400).json({ success: false, message: 'Thiếu món BTP hoặc số lượng thực tế mẻ ra không hợp lệ' });
    }
    const mk = mkey(thang || (new Date().getMonth() + 1), nam || new Date().getFullYear());

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const data = await loadState(client);

      const recipe = (data.btp_recipes?.[branch] || []).find(d => d.id === dish_id);
      if (!recipe) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Không tìm thấy công thức BTP này' });
      }

      if (!data.nvl) data.nvl = [];
      const { totalNvl, missing } = calcRecipeCost(recipe, data.nvl);
      if (missing.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: `Các nguyên liệu sau chưa có trong Danh Mục NVL, hãy thêm trước khi sản xuất: ${missing.join(', ')}`
        });
      }

      // ---- 1&2: tính giá vốn / 1 đơn vị thành phẩm (vd: 1kg) ----
      const costPerUnit = totalNvl / actualQty;

      // ---- 3: ghi giá này vào chính dòng NVL của món BTP (tạo mới nếu chưa có) ----
      // QUAN TRỌNG: so khớp không phân biệt hoa/thường & khoảng trắng, để
      // luôn tìm đúng dòng NVL mà Menu/Menu Tại Chỗ đang tham chiếu, thay vì
      // vô tình tạo ra 1 dòng NVL mới, tách rời, không món nào dùng tới.
      let btpNvlRow = data.nvl.find(n => normName(n.ten) === normName(recipe.name));
      if (!btpNvlRow) {
        const maxId = Math.max(0, ...data.nvl.map(n => n.id || 0));
        btpNvlRow = { id: maxId + 1, ten: recipe.name, dvt: recipe.output_unit, gia: 0, nhom: '🍲 Nhóm BTP' };
        data.nvl.push(btpNvlRow);
      }
      const giaCu = btpNvlRow.gia;
      markBtpGiaSanXuat(btpNvlRow, +costPerUnit.toFixed(2));

      // ---- 4: trừ NVL thô đã dùng cho đúng 1 mẻ theo công thức ----
      if (!data.btp_production) data.btp_production = {};
      if (!data.btp_production[mk]) data.btp_production[mk] = [];
      for (const ing of (recipe.ingredients || [])) {
        const nvlGoc = data.nvl.find(n => normName(n.ten) === normName(ing.ten));
        if (!nvlGoc) continue;
        const dung = unitType(nvlGoc.dvt) === 'mass' ? (parseFloat(ing.dinh_luong || 0) / 1000) : parseFloat(ing.dinh_luong || 0);
        const dungCoHaoHut = dung * (1 + (parseFloat(ing.hao_hut || 0)));
        data.btp_production[mk].push({
          ten: ing.ten,
          sl: dungCoHaoHut,
          branch,
          btp_dish: recipe.name,
          ngay: new Date().toISOString().slice(0, 10)
        });
      }

      // ---- 5: nhập kho đúng số lượng thực tế của BTP ----
      if (!data.inventory) data.inventory = {};
      if (!data.inventory[mk]) data.inventory[mk] = [];
      data.inventory[mk].push({
        ten: recipe.name,
        sl: actualQty,
        gia: btpNvlRow.gia,
        branch,
        loai: 'san_xuat_btp',
        ngay: new Date().toISOString().slice(0, 10)
      });

      await saveState(client, data, req.user.name, req.headers['x-socket-id']);
      await client.query('COMMIT');
      res.json({
        success: true,
        message: `Đã sản xuất "${recipe.name}": ra ${actualQty} ${recipe.output_unit} thực tế. Giá vốn/${recipe.output_unit}: ${Math.round(costPerUnit).toLocaleString('vi-VN')}đ (trước đó: ${Math.round(giaCu || 0).toLocaleString('vi-VN')}đ) — đã cập nhật vào Danh Mục NVL và trừ đúng NVL thô đã dùng.`,
        cost_per_unit: costPerUnit,
        total_nvl: totalNvl
      });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, message: e.message });
    } finally {
      client.release();
    }
  });

  // =====================================================================
  // D. BÁO CÁO CHI PHÍ SẢN XUẤT BTP THEO CHI NHÁNH (không phải doanh thu)
  // =====================================================================

  router.get('/production-report', requireAuth, async (req, res) => {
    const { mk } = req.query;
    try {
      const { rows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
      const raw = rows[0]?.data;
      const data = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      const entries = (mk ? (data.btp_production?.[mk] || []) : Object.values(data.btp_production || {}).flat());
      const nvlList = data.nvl || [];
      const byBranch = {};
      for (const e of entries) {
        const nvlGoc = nvlList.find(n => normName(n.ten) === normName(e.ten));
        const cost = (parseFloat(e.sl) || 0) * (parseFloat(nvlGoc?.gia) || 0);
        byBranch[e.branch] = (byBranch[e.branch] || 0) + cost;
      }
      res.json({ success: true, byBranch, entries: entries.length });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  return router;
};
