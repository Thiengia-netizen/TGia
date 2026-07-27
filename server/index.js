require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const { pool, initSchema } = require('./db');
const { router: authRouter } = require('./auth');
const usersRouter = require('./users');
const stateRouterFactory = require('./state');
const btpRouter = require('./btp'); // MỚI: router riêng cho tính năng BTP

const SECRET = process.env.JWT_SECRET || 'doi-secret-nay-trong-file-.env';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ------------------- API -------------------
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/state', stateRouterFactory(io));
app.use('/api/btp', btpRouter(io)); // MỚI: đường dẫn sạch /api/btp/... khớp với front-end, dùng chung app_state

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ------------------- SOCKET.IO: xac thuc bang JWT (tra lai DB, khong tin token cu) -------------------
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Chưa đăng nhập'));
  jwt.verify(token, SECRET, async (err, decoded) => {
    if (err) return next(new Error('Phiên đăng nhập hết hạn'));
    try {
      // Giống requireAuth ở server/auth.js: luôn tra DB để lấy role/quyền
      // MỚI NHẤT, không tin dữ liệu cũ nằm sẵn trong token (token có thể đã
      // cấp từ trước khi tài khoản bị xoá / hạ quyền).
      const { rows } = await pool.query(
        'SELECT id, username, name, role, is_superadmin FROM users WHERE id = $1',
        [decoded.id]
      );
      if (rows.length === 0) return next(new Error('Tài khoản không còn tồn tại'));
      socket.user = rows[0];
      next();
    } catch (e) {
      next(new Error('Lỗi xác thực'));
    }
  });
});

io.on('connection', (socket) => {
  console.log(`🔌 ${socket.user?.name || 'unknown'} đã kết nối (${socket.id})`);

  const fullTabs = [
    "Dashboard", "Bán Hàng", "Danh Mục NVL", "Nhập Hàng", "Menu & Công Thức",
    "Menu Tại Chỗ", "Chấm Công", "Chi Phí", "Hao Hụt", "Hủy Hàng", "Tồn Kho",
    "Báo Cáo", "Dự Báo DT", "Người Dùng", "dashboard", "banhang", "nvl",
    "inventory", "menu", "bantaicho", "chamcong", "chiphi", "haohut", "huyhang",
    "tonkho", "baocao", "dubaodoanhthu", "users"
  ];

  socket.onAny((eventName, ...args) => {
    if (socket.user?.role === 'admin' || socket.user?.is_superadmin) {
      socket.emit('state-updated', {
        data: { activeTab: "Dashboard", allowedTabs: fullTabs },
        updated_at: new Date(),
        updated_by: 'Hệ thống'
      });
    }
  });

  if (socket.user?.role === 'admin' || socket.user?.is_superadmin) {
    socket.emit('state-updated', {
      data: { activeTab: "Dashboard", allowedTabs: fullTabs },
      updated_at: new Date(),
      updated_by: 'Hệ thống'
    });
  }

  socket.on('disconnect', () => {
    console.log(`🔌 ${socket.user?.name || 'unknown'} đã ngắt kết nối`);
  });
});

// ------------------- FRONTEND TINH (static) -------------------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ------------------- KHOI DONG -------------------
initSchema()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🚀 KhạpKhun server đang chạy tại http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ Lỗi khởi tạo database:', err.message);
    process.exit(1);
  });
