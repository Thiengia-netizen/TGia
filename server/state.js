const express = require('express');
const { pool } = require('./db');
const { requireAuth } = require('./auth');
const { reconcileBtpNvl, filterBtpSecrets } = require('./btp-nvl-sync');

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

      // 🔒 CHỐT AN TOÀN THẬT SỰ: lọc bỏ công thức/số liệu BTP mà user này
      // không có quyền xem TRƯỚC KHI gửi xuống trình duyệt — không chỉ ẩn ở
      // giao diện, dữ liệu chưa từng rời khỏi server nếu không đủ quyền.
      responseData = filterBtpSecrets(responseData, req.user);

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
      // 🔒🩹 CHỐT AN TOÀN CHỐNG MẤT DỮ LIỆU BTP: vì GET /api/state đã lọc rỗng
      // btp_recipes/btp_production của chi nhánh mà người này KHÔNG có quyền
      // xem — nếu họ lưu BẤT KỲ thay đổi nào khác (sửa NVL, nhập bán hàng...),
      // trình duyệt vẫn gửi lên NGUYÊN KHỐI dữ liệu đang cầm (rỗng ở phần đó),
      // và nếu lưu thẳng sẽ XOÁ MẤT dữ liệu THẬT trên server. Cách khắc: đọc
      // lại dữ liệu HIỆN CÓ trên server trước khi ghi, và với mỗi chi nhánh
      // người này không có quyền, LUÔN GIỮ NGUYÊN bản trên server, bỏ qua
      // hoàn toàn phần họ gửi lên cho chi nhánh đó.
      const { rows: curRows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
      const curRaw = curRows[0]?.data;
      const currentData = curRaw ? (typeof curRaw === 'string' ? JSON.parse(curRaw) : curRaw) : {};
      const isSuper = !!req.user.is_superadmin;
      const perm = currentData.user_btp_tabs?.[req.user.id] || [];
      const canKK = isSuper || perm.includes('btp-khapkhun');
      if (!canKK) {
        data.btp_recipes = { ...(data.btp_recipes || {}), khapkhun: currentData.btp_recipes?.khapkhun || [] };
        data.btp_recipes_deleted = { ...(data.btp_recipes_deleted || {}), khapkhun: currentData.btp_recipes_deleted?.khapkhun || [] };
        // btp_production: giữ lại các dòng cũ (người này không có quyền BTP),
        // bỏ qua các dòng client gửi lên (không có quyền để tạo mới).
        const mergedProd = {};
        const allMk = new Set([...Object.keys(currentData.btp_production || {}), ...Object.keys(data.btp_production || {})]);
        for (const mk of allMk) {
          mergedProd[mk] = currentData.btp_production?.[mk] || [];
        }
        data.btp_production = mergedProd;
      }

      // Đảm bảo dữ liệu lưu trữ luôn đi kèm quyền lực 14 Tab
      data.allowedTabs = fullTabs;

      // QUAN TRỌNG: trình duyệt gửi lên TOÀN BỘ dữ liệu app mỗi lần lưu —
      // nếu tab đó đang cầm dữ liệu NVL/BTP cũ (trước khi có thay đổi từ
      // thiết bị khác hoặc từ chính trang BTP), lưu thẳng sẽ VÔ TÌNH ghi đè
      // mất thay đổi đó. Tự sửa lại đúng nhóm/giá NVL của các món BTP NGAY
      // TRƯỚC KHI LƯU, mỗi lần, để không bao giờ mất đồng bộ. (Hàm này cũng
      // tự tính lại btp_raw_expansion từ btp_recipes VỪA được khôi phục ở
      // trên, nên luôn đúng, không bị lệch theo dữ liệu rỗng.)
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
      // 🔒 MỖI socket nhận bản dữ liệu đã lọc THEO ĐÚNG quyền BTP của CHÍNH người đó —
      // không phát chung 1 bản đầy đủ cho tất cả (đó chính là lỗ hổng rò rỉ công thức).
      const senderSocketId = req.headers['x-socket-id'];
      io.sockets.sockets.forEach((s) => {
        if (s.id !== senderSocketId) {
          const filteredForThisUser = filterBtpSecrets(data, s.user);
          s.emit('state-updated', { data: filteredForThisUser, updated_at, updated_by: req.user.name });
        }
      });

      res.json({ updated_at, updated_by: req.user.name });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
