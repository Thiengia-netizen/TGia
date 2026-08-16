// server/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'doi-secret-nay-trong-file-.env';

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      is_superadmin: !!user.is_superadmin
    },
    SECRET,
    { expiresIn: '30d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Chưa đăng nhập' });
  const token = header.split(' ')[1];
  jwt.verify(token, SECRET, async (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại' });
    try {
      // QUAN TRỌNG: KHÔNG tin thẳng role/is_superadmin nằm sẵn trong token —
      // token có thể được cấp từ nhiều ngày/tuần trước (hạn 30 ngày). Nếu
      // tài khoản đó sau này bị xoá, hạ quyền, hay đổi mật khẩu, token cũ
      // vẫn còn "sống" và vẫn ký hợp lệ — phải tra lại DATABASE THẬT mỗi
      // lần để biết trạng thái ĐÚNG HIỆN TẠI. Đây là lỗ hổng đã khiến các
      // tài khoản đã xoá / hạ quyền vẫn đăng nhập được với quyền cũ.
      const { rows } = await pool.query(
        'SELECT id, username, name, role, is_superadmin FROM users WHERE id = $1',
        [decoded.id]
      );
      if (rows.length === 0) {
        return res.status(401).json({ error: 'Tài khoản không còn tồn tại, vui lòng đăng nhập lại' });
      }
      req.user = rows[0]; // luôn dùng dữ liệu MỚI NHẤT từ DB, không dùng decoded
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Chỉ Quản lý mới có quyền này' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user?.is_superadmin) {
    return res.status(403).json({ error: 'Chỉ Super Admin mới có quyền này' });
  }
  next();
}

// ------------------- LOGIN -------------------
// LƯU Ý: KHÔNG còn cổng hậu (backdoor) bẻ khóa cứng cho bất kỳ tài khoản nào.
// Toàn bộ đăng nhập đi qua database + bcrypt, an toàn và nhất quán.
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Thiếu tài khoản hoặc mật khẩu' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
    const user = rows[0];

    if (!user.password_hash) {
      // Tài khoản tồn tại nhưng chưa từng được cấp mật khẩu hợp lệ
      return res.status(401).json({ error: 'Tài khoản chưa được khởi tạo mật khẩu, liên hệ Super Admin' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });

    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        is_superadmin: user.is_superadmin
      }
    });
  } catch (e) {
    console.error('Lỗi /api/auth/login:', e);
    res.status(500).json({ error: e.message });
  }
});

// ------------------- ĐỔI MẬT KHẨU CỦA CHÍNH MÌNH -------------------
router.post('/change-password', requireAuth, async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!new_password || new_password.length < 4) {
    return res.status(400).json({ error: 'Mật khẩu mới phải từ 4 ký tự trở lên' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });

    const ok = await bcrypt.compare(old_password || '', user.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ message: 'Đã đổi mật khẩu' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------- ĐẶT LẠI TÀI KHOẢN ADMIN (dùng khi bị khoá ngoài, không đăng nhập được) -------------------
// Chỉ hoạt động khi bạn đã đặt biến môi trường ADMIN_RESET_SECRET trên Render.
// Cách dùng: xem hướng dẫn "Đặt lại mật khẩu admin" trong tài liệu đi kèm.
// KHUYẾN NGHỊ: sau khi dùng xong và đăng nhập lại được, hãy XÓA biến ADMIN_RESET_SECRET
// khỏi Render (hoặc đổi giá trị khác) để đóng cửa này lại, tránh để hở lâu dài.
router.post('/bootstrap-reset', async (req, res) => {
  const { secret, username, password } = req.body;
  if (!process.env.ADMIN_RESET_SECRET) {
    return res.status(403).json({ error: 'Chưa bật tính năng này (thiếu biến môi trường ADMIN_RESET_SECRET trên Render)' });
  }
  if (!secret || secret !== process.env.ADMIN_RESET_SECRET) {
    return res.status(403).json({ error: 'Mã bí mật không đúng' });
  }
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: 'Thiếu username hoặc password (password phải từ 4 ký tự)' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, name, role, is_superadmin)
       VALUES ($1,$2,$3,'admin',true)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, role = 'admin', is_superadmin = true`,
      [username, hash, username]
    );
    res.json({ ok: true, message: `Đã đặt tài khoản Super Admin: "${username}" — đăng nhập lại ngay bây giờ.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, requireAuth, requireAdmin, requireSuperAdmin };
