const express = require('express');
const { pool } = require('./db');
const { requireAuth } = require('./auth');
const { reconcileBtpNvl } = require('./btp-nvl-sync');

module.exports = function (io) {
  const router = express.Router();

  // 1. KHÓA CỨNG DANH SÁCH 14 TAB ĐỂ FRONT-END KHÔNG THỂ ẨN MENU CỦA ADMIN
  const fullTabs = [
    "Dashboard", "Bán Hàng", "Danh Mục NVL", "Nhập Hàng", "Menu & Công Thức", 
    "Menu Tại Chỗ", "Chấm Công", "Chi Phí", "Hao Hụt", "Hủy Hàng", "Tồn Kho", 
    "Báo Cáo", "Dự Báo DT", "Người Dùng", "dashboard", "banhang", "nvl", 
    "inventory", "menu", "bantaicho", "chamcong", "chiphi", "haohut", "huyhang", 
    "tonkho", "baocao", "dubaodoanhthu", "users"
  ];

  // Lay toan bo du lieu (S object) hien dang luu tren server
  router.get('/', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT data, updated_at, updated_by FROM app_state WHERE id = 1');
      
      let responseData = { activeTab: "Dashboard", allowedTabs: fullTabs };
      let updated_at = rows[0]?.updated_at || null;
      
      if (rows && rows[0]) {
        try {
          // Nếu có dữ liệu trong DB, đọc ra để giữ lại các thông tin cấu hình quán của bạn
          let dbData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;

          // Đồng bộ lại Nhóm BTP NGAY CẢ KHI CHỈ ĐỌC — nếu có gì lệch (VD:
          // giá NVL thô vừa đổi khiến giá ước tính BTP đổi theo, hoặc dữ
          // liệu cũ chưa từng được chỉnh sửa lần nào để tự sửa), lưu lại
          // luôn để lần đọc sau (từ thiết bị khác) cũng thấy đúng ngay.
          if (reconcileBtpNvl(dbData)) {
            console.log('🍲 [GET /api/state] Đã tự đồng bộ lại Nhóm BTP trong NVL.');
            const upd = await pool.query(
              `UPDATE app_state SET data = $1, updated_at = now(), updated_by = $2 WHERE id = 1 RETURNING updated_at`,
              [JSON.stringify(dbData), 'system-sync-btp-nhom']
            );
            updated_at = upd.rows[0]?.updated_at || updated_at;
          }

          responseData = { ...dbData, allowedTabs: fullTabs };
        } catch (e) {
          console.error("Lỗi phân tích JSON dữ liệu cũ:", e.message);
        }
      }

      // ÉP BUỘC TRẢ VỀ: Cho dù DB trống hay lỗi, mảng allowedTabs trả về web luôn có đủ 14 Tab cố định
      res.json({ 
        data: responseData, 
        updated_at, 
        updated_by: rows[0]?.updated_by || null 
      });

    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Luu toan bo du lieu, roi bao cho cac thiet bi khac dang mo app biet de cap nhat
  router.put('/', requireAuth, async (req, res) => {
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
    }
    try {
      // Đảm bảo dữ liệu lưu trữ luôn đi kèm quyền lực 14 Tab
      data.allowedTabs = fullTabs;

      // QUAN TRỌNG: trình duyệt gửi lên TOÀN BỘ dữ liệu app mỗi lần lưu —
      // nếu tab đó đang cầm dữ liệu NVL/BTP cũ (trước khi có thay đổi từ
      // thiết bị khác hoặc từ chính trang BTP), lưu thẳng sẽ VÔ TÌNH ghi đè
      // mất thay đổi đó. Tự sửa lại đúng nhóm/giá NVL của các món BTP NGAY
      // TRƯỚC KHI LƯU, mỗi lần, để không bao giờ mất đồng bộ.
      reconcileBtpNvl(data);
      const { rows } = await pool.query(
        `INSERT INTO app_state (id, data, updated_at, updated_by)
         VALUES (1, $1, now(), $2)
         ON CONFLICT (id) 
         DO UPDATE SET data = $1, updated_at = now(), updated_by = $2
         RETURNING updated_at`,
        [JSON.stringify(data), req.user.name]
      );
      const updated_at = rows[0].updated_at;

      // Bao cho tat ca thiet bi khac (tru thiet bi vua luu) de tu dong cap nhat man hinh
      const senderSocketId = req.headers['x-socket-id'];
      io.sockets.sockets.forEach((s) => {
        if (s.id !== senderSocketId) {
          s.emit('state-updated', { data, updated_at, updated_by: req.user.name });
        }
      });

      res.json({ updated_at, updated_by: req.user.name });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
