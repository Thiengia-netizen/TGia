// server/db.js
// Ket noi PostgreSQL + khoi tao / tu vá cau truc bang du lieu khi server khoi dong.
// File nay duoc viet de AN TOAN chay lai nhieu lan (idempotent) va KHONG lam mat
// du lieu nguoi dung / du lieu app da co san tren Render, ke ca khi bang da ton tai
// voi cau truc cu (thieu cot) tu cac lan deploy truoc.

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const BTP_SEED = require('./btp-seed-data');
const { reconcileBtpNvl } = require('./btp-nvl-sync');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function initSchema() {
  // ------------------------------------------------------------------
  // 1. BANG users
  // ------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Vá cho database CŨ (đã tồn tại từ trước với schema thiếu cột) —
  // đây chính là nguyên nhân gây lỗi "không đăng nhập được".
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();`);

  // Neu ban dau bang co cot "password" (kieu VARCHAR NOT NULL, luu thuong)
  // thi go bo rang buoc NOT NULL de khong chan viec tao user moi (chi dung password_hash tu nay).
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'password'
      ) THEN
        ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
      END IF;
    END $$;
  `);

  // Neu co user cu bi thieu "name", tam thoi dien = username de khong bi rong tren giao dien
  await pool.query(`UPDATE users SET name = username WHERE name IS NULL;`);

  // ------------------------------------------------------------------
  // 2. BANG app_state  (LƯU Ý: tên phải khớp với server/state.js — đây là
  //    lỗi thứ 2 đã gây crash ngay sau khi đăng nhập ở bản cũ, vì bản cũ
  //    tạo bảng tên "state" trong khi state.js lại đọc bảng "app_state")
  // ------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      updated_by TEXT,
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);

  const stateRes = await pool.query('SELECT id FROM app_state WHERE id = 1');
  if (stateRes.rows.length === 0) {
    await pool.query(
      'INSERT INTO app_state (id, data, updated_by) VALUES (1, $1, $2)',
      [JSON.stringify({}), 'system']
    );
  }

  // ------------------------------------------------------------------
  // 3. (ĐÃ BỎ) Trước đây ở đây có 3 bảng SQL riêng cho NVL/công thức BTP
  //    (nvl_kho, btp_recipes, btp_export_logs). Đã loại bỏ vì trùng lặp
  //    với dữ liệu NVL/menu/tồn kho vốn đã sống trong app_state.data
  //    (S.nvl, S.menu, S.inventory...) — xem server/btp.js bản mới để
  //    biết công thức BTP giờ được lưu ở đâu (data.btp_recipes,
  //    data.btp_production, bên trong CHÍNH bảng app_state).
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 4. BANG btp_branch_auth — mật khẩu RIÊNG cho từng file BTP,
  //    lưu dạng HASH trong DB (không hardcode trong code / không lộ trong
  //    biến môi trường công khai), do Super Admin cấp/đổi qua giao diện.
  //    (Đây vẫn cần một bảng SQL thật sự — vì đây là quyền truy cập cần
  //    máy chủ tự kiểm tra độc lập, không thể để trong app_state vì bất kỳ
  //    ai đăng nhập cũng có thể ghi đè app_state.)
  // ------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS btp_branch_auth (
      branch TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      updated_by TEXT
    );
  `);

  // ------------------------------------------------------------------
  // 5. Seed tài khoản quản lý đầu tiên NẾU bảng users đang trống hẳn
  //    (an toàn: không đụng tới user đã có sẵn)
  // ------------------------------------------------------------------
  const { rows: userCountRows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (userCountRows[0].c === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, name, role, is_superadmin) VALUES ($1,$2,$3,$4,true)',
      [username, hash, 'Quản lý', 'admin', true]
    );
    console.log(`✅ Đã tạo tài khoản quản lý đầu tiên — username: "${username}"`);
    console.log('⚠️  Hãy đổi mật khẩu này ngay sau khi đăng nhập lần đầu (mục Người Dùng)!');
  }

  // Nếu database cũ có user "Khapkhun" với cột password (plaintext) từ bản lỗi
  // trước đây và CHƯA có password_hash -> cấp lại password_hash hợp lệ để
  // không ai còn phải dùng cổng hậu (backdoor) nữa. Mật khẩu tạm lấy theo
  // ADMIN_PASSWORD (hoặc "admin123" nếu chưa đặt) — đổi ngay sau khi login.
  await pool.query(`
    UPDATE users
    SET password_hash = COALESCE(password_hash, $1)
    WHERE password_hash IS NULL
  `, [await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10)]);

  // ------------------------------------------------------------------
  // 8. Super Admin DUY NHẤT theo Environment Variable `SUPERADMIN_USERNAME`
  //    ---------------------------------------------------------------
  //    Chạy lại MỖI LẦN server khởi động (không chỉ lần đầu) — đảm bảo
  //    đúng 1 tài khoản (do bạn chỉ định qua Render > Environment) luôn
  //    luôn là Super Admin, bất kể trước đó có bao nhiêu tài khoản khác
  //    từng được phong (qua API, qua bootstrap-reset, hay qua các bản vá
  //    trước đây). Đặt biến `SUPERADMIN_USERNAME=sabai` trên Render để
  //    chốt "sabai" làm quyền tối cao vĩnh viễn, theo đúng yêu cầu.
  //
  //    An toàn chống lỗi gõ sai: nếu username trong biến môi trường không
  //    khớp bất kỳ tài khoản nào đang có, sẽ BỎ QUA bước này (không đụng
  //    tới ai) và chỉ in cảnh báo — tránh trường hợp gõ sai làm mất hết
  //    Super Admin, không ai vào cấu hình được nữa.
  // ------------------------------------------------------------------
  if (process.env.SUPERADMIN_USERNAME) {
    const target = process.env.SUPERADMIN_USERNAME;
    const { rows: matchRows } = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [target]
    );
    if (matchRows.length > 0) {
      await pool.query(
        'UPDATE users SET is_superadmin = (LOWER(username) = LOWER($1))',
        [target]
      );
      console.log(`🔐 Super Admin duy nhất (theo SUPERADMIN_USERNAME): "${target}"`);
    } else {
      console.log(`⚠️  SUPERADMIN_USERNAME="${target}" không khớp tài khoản nào đang có — bỏ qua, không đổi quyền ai cả. Hãy tạo tài khoản này trước (mục Người Dùng, hoặc dùng /api/auth/bootstrap-reset).`);
    }
  } else {
    // Không đặt biến môi trường -> giữ hành vi cũ: nếu chưa ai là Super
    // Admin, phong tài khoản admin lâu đời nhất (chỉ chạy khi trống hẳn).
    const superCheck = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE is_superadmin = true');
    if (superCheck.rows[0].c === 0) {
      const { rows: oldestAdmin } = await pool.query(
        "SELECT id, username FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1"
      );
      if (oldestAdmin.length > 0) {
        await pool.query('UPDATE users SET is_superadmin = true WHERE id = $1', [oldestAdmin[0].id]);
        console.log(`🔐 Đã phong tài khoản "${oldestAdmin[0].username}" thành Super Admin.`);
      }
    }
  }

  // ------------------------------------------------------------------
  // 9. Seed mật khẩu mặc định cho 2 file BTP nếu chưa từng được đặt
  //    (BẮT BUỘC đổi ngay sau khi deploy lần đầu, xem hướng dẫn bên dưới)
  // ------------------------------------------------------------------
  const defaultBtpPass = {
    khapkhun: process.env.BTP_PASS_KHAPKHUN_INIT || 'doimatkhaunay-kk'
  };
  for (const branch of Object.keys(defaultBtpPass)) {
    const exists = await pool.query('SELECT branch FROM btp_branch_auth WHERE branch = $1', [branch]);
    if (exists.rows.length === 0) {
      const hash = await bcrypt.hash(defaultBtpPass[branch], 10);
      await pool.query(
        'INSERT INTO btp_branch_auth (branch, password_hash, updated_by) VALUES ($1,$2,$3)',
        [branch, hash, 'system-seed']
      );
      console.log(`🔑 Đã tạo mật khẩu mặc định cho file BTP "${branch}" — vui lòng đổi ngay.`);
    }
  }

  // ------------------------------------------------------------------
  // 10. ĐỔI TÊN các món BTP đã lỡ tạo với tên KHÔNG khớp NVL (sai lệch từ
  //     bản seed cũ trước đây) về đúng tên NVL mà Menu / Menu Tại Chỗ đang
  //     dùng — để giá vốn từ "Sản Xuất Mẻ BTP" cập nhật đúng chỗ, không tạo
  //     ra dòng NVL rác, không liên quan. PHẢI chạy TRƯỚC bước seed (11).
  // ------------------------------------------------------------------
  await renameLegacyBtpDishNames();

  // ------------------------------------------------------------------
  // 11. SEED CÔNG THỨC BTP GỐC (khớp file Excel) — CHỈ THÊM PHẦN CÒN
  //     THIẾU, không bao giờ ghi đè NVL / công thức bạn đã tự chỉnh.
  //     Xem chi tiết ở server/btp-seed-data.js + hàm seedBtpRecipes() dưới.
  // ------------------------------------------------------------------
  await seedBtpRecipes();

  // ------------------------------------------------------------------
  // 12. DỌN NHÓM BTP TRONG DANH MỤC NVL — chạy MỖI LẦN khởi động (không
  //     chỉ 1 lần), để nhóm "🍲 Nhóm BTP" LUÔN chỉ chứa đúng những món đang
  //     có công thức thật ở file BTP Khạp Khun. NVL
  //     nào từng bị gắn nhầm vào nhóm BTP (không phải tạo ra từ file BTP)
  //     sẽ được đẩy về "📦 Nhóm Hàng Khô" — KHÔNG xoá, KHÔNG đổi giá, chỉ
  //     đổi nhóm để bạn tự phân loại lại nếu cần.
  // ------------------------------------------------------------------
  await syncNhomBtpTrongNvl();

  console.log('✅ initSchema hoàn tất — cấu trúc database đã đồng bộ với code.');
}

// Chuẩn hoá tên để so khớp không phân biệt hoa/thường, khoảng trắng thừa
function normName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Bản đồ đổi tên: tên món BTP CŨ (từng bị seed sai, lệch với tên NVL thật) ->
// tên ĐÚNG khớp với NVL mà Menu & Công Thức / Menu Tại Chỗ đang tham chiếu.
const BTP_DISH_RENAME_MAP = {
  'btp-cốt lèo 2kg4': 'Btp - cốt lèo',
  'btp-sốt pad': 'Btp - sốt pad',
  'btp-somtam 6l': 'Btp - somtam',
  'btp- sốt xiên nướng': 'Btp - sốt xiên nướng',
  'btp- satế': 'Btp - Sa tế',
  'cốt dừa': 'Btp - Cốt dừa',
  'xôi lá dứa': 'Xôi lá dứa', // chỉ chuẩn hoá hoa/thường, giữ nguyên
  'btp - trà tắc thái xanh': 'BTP - Trà Thái Xanh',
  'btp - trà tắc thái đỏ': 'Btp - Trà Thái Đỏ',
  'btp- trà olong': 'Btp - Trà Olong',
  'btp - sốt ướp gà yang gai': 'Btp - Sốt Gà Nướng Yang Gai',
  'btp- mắm gỏi cá trê': 'Btp - Mắm Gỏi',
  'lèo hủ tiếu 15l': 'Lèo hủ tiếu',
  'btp- mắm cá thái 1kg': 'Btp - Mắm Cá Thái',
  'trà sữa thái xanh': 'Btp - Trà Sữa Thái Xanh',
  'btp - trà sữa thái đỏ': 'Btp - Trà Sữa Thái Đỏ',
};

// Đổi tên món BTP theo BTP_DISH_RENAME_MAP — CHỈ đổi khi:
//  (a) món tên CŨ tồn tại, VÀ
//  (b) chưa có món nào khác trong CÙNG chi nhánh đã mang tên ĐÚNG (tránh
//      trùng/đè dữ liệu bạn đã tự tạo đúng tên rồi).
// Không bao giờ xoá hay gộp dữ liệu — chỉ đổi field "name" tại chỗ.
async function renameLegacyBtpDishNames() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM app_state WHERE id = 1 FOR UPDATE');
    if (rows.length === 0) { await client.query('ROLLBACK'); return; }
    const raw = rows[0].data;
    const data = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    if (!data.btp_recipes) { await client.query('ROLLBACK'); return; }

    let renamed = 0;
    const skipped = [];
    for (const branch of ['khapkhun']) {
      const list = data.btp_recipes[branch];
      if (!Array.isArray(list)) continue;
      const existingNamesNorm = new Set(list.map(d => normName(d.name)));
      for (const dish of list) {
        const correct = BTP_DISH_RENAME_MAP[normName(dish.name)];
        if (!correct || normName(dish.name) === normName(correct)) continue;
        if (existingNamesNorm.has(normName(correct))) {
          skipped.push(`${branch}:${dish.name}`);
          continue;
        }
        existingNamesNorm.delete(normName(dish.name));
        dish.name = correct;
        existingNamesNorm.add(normName(correct));
        renamed++;
      }
    }

    if (renamed > 0) {
      await client.query(
        `UPDATE app_state SET data = $1, updated_at = now(), updated_by = $2 WHERE id = 1`,
        [JSON.stringify(data), 'system-rename-btp']
      );
      console.log(`🔤 Đã đổi tên ${renamed} món BTP cho khớp đúng tên NVL (để giá vốn cập nhật đúng chỗ).`);
    }
    if (skipped.length > 0) {
      console.log(`⚠️  Bỏ qua đổi tên cho: ${skipped.join(', ')} — đã có món khác trùng tên đúng, kiểm tra tay nếu cần.`);
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('⚠️  Lỗi đổi tên món BTP (không chặn server khởi động):', e.message);
  } finally {
    client.release();
  }
}

// Seed idempotent: thêm NVL còn thiếu vào data.nvl, thêm công thức BTP còn
// thiếu vào data.btp_recipes.khapkhun (so khớp theo TÊN, không
// phân biệt hoa/thường). KHÔNG BAO GIỜ sửa/xoá NVL hay công thức đã có sẵn —
// an toàn tuyệt đối với dữ liệu bạn đã tự nhập/chỉnh trong app.
async function seedBtpRecipes() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM app_state WHERE id = 1 FOR UPDATE');
    if (rows.length === 0) { await client.query('ROLLBACK'); return; }
    const raw = rows[0].data;
    const data = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});

    if (!Array.isArray(data.nvl)) data.nvl = [];
    if (!data.btp_recipes) data.btp_recipes = { khapkhun: [] };
    if (!Array.isArray(data.btp_recipes.khapkhun)) data.btp_recipes.khapkhun = [];

    let addedNvl = 0, addedRecipes = 0;

    // ---- 10a. Thêm NVL còn thiếu (bỏ qua những tên đã bị người dùng
    //           chủ động xoá — xem data.nvl_deleted, tôn trọng quyết định
    //           xoá của người dùng, không tự "hồi sinh" mỗi lần server
    //           khởi động lại, vd. sau khi Render free tier ngủ/thức) ----
    const existingNvlNames = new Set(data.nvl.map(n => normName(n.ten)));
    const deletedNvlNames = new Set((data.nvl_deleted || []).map(normName));
    for (const n of BTP_SEED.nvl) {
      if (existingNvlNames.has(normName(n.ten))) continue;
      if (deletedNvlNames.has(normName(n.ten))) continue;
      const maxId = Math.max(0, ...data.nvl.map(x => x.id || 0));
      data.nvl.push({ id: maxId + 1, ten: n.ten, dvt: n.dvt, gia: n.gia, nhom: n.nhom, hao_hut: 0, ton_dau: 0 });
      existingNvlNames.add(normName(n.ten));
      addedNvl++;
    }

   // ---- 10b. Thêm công thức BTP còn thiếu, cho CẢ 2 chi nhánh — BỎ QUA
    //           món nào người dùng đã CHỦ ĐỘNG XÓA khỏi chi nhánh đó (xem
    //           data.btp_recipes_deleted), để 2 file BTP thật sự tách biệt,
    //           không còn bị "hồi sinh" giống nhau mỗi lần server khởi động
    //           lại / deploy lại — dùng đúng cơ chế "bia mộ" giống hệt
    //           data.nvl_deleted ở bước 10a phía trên.
    // ------------------------------------------------------------------
    if (!data.btp_recipes_deleted) data.btp_recipes_deleted = { khapkhun: [] };
    for (const branch of ['khapkhun']) {
      const list = data.btp_recipes[branch];
      const existingNames = new Set(list.map(d => normName(d.name)));
      const deletedNames = new Set((data.btp_recipes_deleted[branch] || []).map(normName));
      for (const dish of (BTP_SEED.recipes[branch] || [])) {
        if (existingNames.has(normName(dish.name))) continue;
        if (deletedNames.has(normName(dish.name))) continue;
        const maxId = Math.max(0, ...list.map(d => d.id || 0));
        list.push({
          id: maxId + 1,
          name: dish.name,
          output_unit: dish.output_unit,
          ingredients: dish.ingredients.map(i => ({ ten: i.ten, dinh_luong: i.dinh_luong, hao_hut: i.hao_hut }))
        });
        existingNames.add(normName(dish.name));
        addedRecipes++;
      }
    }

    if (addedNvl > 0 || addedRecipes > 0) {
      await client.query(
        `UPDATE app_state SET data = $1, updated_at = now(), updated_by = $2 WHERE id = 1`,
        [JSON.stringify(data), 'system-seed-btp']
      );
      console.log(`🍲 Seed BTP: đã thêm ${addedNvl} NVL mới và ${addedRecipes} công thức BTP còn thiếu.`);
    } else {
      console.log('🍲 Seed BTP: dữ liệu đã đầy đủ, không cần thêm gì.');
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('⚠️  Lỗi seed công thức BTP (không chặn server khởi động):', e.message);
  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema };

// Đồng bộ Nhóm BTP trong NVL mỗi khi server khởi động, dùng CHUNG đúng 1 quy
// tắc với server/btp-nvl-sync.js (cũng là quy tắc mà state.js và btp.js áp
// dụng mỗi lần lưu) — để không bao giờ lệch nhau giữa các nơi ghi dữ liệu.
async function syncNhomBtpTrongNvl() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM app_state WHERE id = 1 FOR UPDATE');
    if (rows.length === 0) { await client.query('ROLLBACK'); return; }
    const raw = rows[0].data;
    const data = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});

    const changed = reconcileBtpNvl(data);

    if (changed) {
      await client.query(
        `UPDATE app_state SET data = $1, updated_at = now(), updated_by = $2 WHERE id = 1`,
        [JSON.stringify(data), 'system-sync-btp-nhom']
      );
      console.log('🧹 Đã đồng bộ lại Nhóm BTP trong Danh Mục NVL theo đúng 2 file BTP hiện có.');
    } else {
      console.log('🧹 Nhóm BTP trong NVL đã khớp đúng data BTP, không cần chỉnh gì.');
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('⚠️  Lỗi dọn Nhóm BTP (không chặn server khởi động):', e.message);
  } finally {
    client.release();
  }
}
