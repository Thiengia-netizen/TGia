// server/users.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('./auth');

const router = express.Router();

// Danh sach nguoi dung (khong tra ve mat khau)
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, name, role, is_superadmin, created_at FROM users ORDER BY id ASC'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Them nguoi dung moi
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name) {
    return res.status(400).json({ error: 'Thiếu thông tin' });
  }
  if (!['admin', 'staff', 'bep', 'phucvu', 'thungan'].includes(role)) {
    return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  }
  // Chỉ Super Admin được tạo tài khoản Quản Lý (role='admin'). Quản Lý thường
  // chỉ được tạo tài khoản Nhân Viên (staff/bep/phucvu/thungan).
  if (role === 'admin' && !req.user.is_superadmin) {
    return res.status(403).json({ error: 'Chỉ Super Admin mới được tạo tài khoản Quản Lý' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id, username, name, role',
      [username.trim(), hash, name.trim(), role]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Tài khoản này đã tồn tại' });
    res.status(500).json({ error: e.message });
  }
});

// Cap nhat (doi ten / vai tro / reset mat khau)
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, role, password } = req.body;
  try {
    if (name) await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name, id]);
    if (role && ['admin', 'staff', 'bep', 'phucvu', 'thungan'].includes(role)) {
      // Chỉ Super Admin được thăng/hạ vai trò Quản Lý (role='admin') cho người khác.
      const current = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
      const isRoleChangeInvolvingAdmin = role === 'admin' || current.rows[0]?.role === 'admin';
      if (isRoleChangeInvolvingAdmin && !req.user.is_superadmin) {
        return res.status(403).json({ error: 'Chỉ Super Admin mới được đổi vai trò Quản Lý' });
      }
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
    }
    res.json({ message: 'Đã cập nhật' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Xoa nguoi dung
// Quy tac: - Khong ai xoa duoc tai khoan Super Admin.
//          - Chi Super Admin moi xoa duoc tai khoan Quan Ly (role='admin').
//          - Quan Ly (va Super Admin) deu xoa duoc tai khoan Nhan Vien thuong.
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (parseInt(id, 10) === req.user.id) {
    return res.status(400).json({ error: 'Không thể tự xoá chính mình' });
  }
  try {
    const target = await pool.query('SELECT role, is_superadmin, name FROM users WHERE id = $1', [id]);
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    }
    const t = target.rows[0];
    if (t.is_superadmin) {
      return res.status(403).json({ error: 'Không thể xoá tài khoản Super Admin' });
    }
    if (t.role === 'admin' && !req.user.is_superadmin) {
      return res.status(403).json({ error: 'Chỉ Super Admin mới được xoá tài khoản Quản Lý' });
    }
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ message: 'Đã xoá' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bat/tat quyen Super Admin cho 1 tai khoan — CHI Super Admin duoc lam viec nay.
// Dung de: giu lai dung 1 tai khoan Super Admin (vi du "sabai"), go bot cac
// tai khoan Super Admin thua ra da bi tao/thang cap ngoai y muon.
router.post('/:id/superadmin', requireAuth, requireSuperAdmin, async (req, res) => {
  const { id } = req.params;
  const { value } = req.body; // true = phong len Super Admin, false = ha xuong
  try {
    if (value === false) {
      // Khong cho ha tai khoan Super Admin CUOI CUNG xuong -> luon phai con it nhat 1 nguoi
      const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE is_superadmin = true');
      if (rows[0].c <= 1) {
        return res.status(400).json({ error: 'Phải giữ lại ít nhất 1 tài khoản Super Admin' });
      }
    }
    await pool.query('UPDATE users SET is_superadmin = $1 WHERE id = $2', [!!value, id]);
    res.json({ message: value ? 'Đã phong Super Admin' : 'Đã hạ quyền Super Admin' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
