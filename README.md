# 🍜 Khạp Khun — Hệ Thống Quản Lý (Bản Độc Lập 1 Chi Nhánh)

> **Đây là bản tách riêng, độc lập 100%** từ hệ thống Pinoong gốc — dùng cho
> đúng 1 cửa hàng Khạp Khun, có backend + database riêng, không chia sẻ dữ
> liệu với bất kỳ chi nhánh nào khác. Toàn bộ tính năng "BTP Pinoong" đã được
> loại bỏ, chỉ còn lại 1 tab BTP duy nhất cho Khạp Khun. Giao diện giữ nguyên
> bố cục gốc, chỉ đổi tông màu sang xanh cổ vịt (`#046567`) trên nền trắng.

Đây là app **KhạpKhun** gốc của bạn, được nâng cấp để:
- ✅ Nhiều người **đăng nhập cùng lúc** từ nhiều thiết bị/nơi khác nhau qua Internet
- ✅ Dữ liệu lưu **chung trên 1 server**, không còn lưu riêng từng máy (localStorage) nữa
- ✅ **Tự động đồng bộ real-time**: ai lưu dữ liệu, các máy khác đang mở app sẽ thấy cập nhật gần như ngay lập tức
- ✅ Có **đăng nhập + phân quyền** (Quản lý / Nhân viên), Quản lý có thể tạo/xoá tài khoản nhân viên

Toàn bộ giao diện, công thức, cách tính giá vốn, hao hụt, báo cáo... **giữ nguyên 100%** như bản bạn đang dùng — chỉ phần "lưu dữ liệu" là được thay đổi.

---

## 1. Cấu trúc project

```
khapkhun-solo/
├── package.json
├── .env.example        ← copy thành .env khi chạy ở máy local
├── server/
│   ├── index.js          ← server chính (Express + Socket.io)
│   ├── db.js              ← kết nối PostgreSQL, tự tạo bảng khi khởi động, seed dữ liệu BTP Khạp Khun
│   ├── auth.js             ← đăng nhập, đổi mật khẩu, xác thực JWT
│   ├── users.js              ← quản lý tài khoản (Quản Lý / Super Admin)
│   ├── state.js                ← lưu/tải dữ liệu app + đồng bộ real-time
│   ├── btp.js                   ← API công thức BTP (chỉ còn nhánh Khạp Khun)
│   ├── btp-nvl-sync.js            ← đồng bộ Nhóm BTP trong Danh Mục NVL
│   └── btp-seed-data.js            ← 22 công thức BTP gốc + 102 NVL (dữ liệu mẫu Khạp Khun)
└── public/
    ├── index.html          ← toàn bộ giao diện app (đã đổi màu xanh cổ vịt + nền trắng)
    ├── import-thongminh.js  ← xử lý Import Excel/Ảnh(OCR)/PDF
    └── BTP-KhapKhun.html      ← file BTP in ấn/offline riêng cho Khạp Khun
```

---

## 2. Deploy miễn phí lên Internet (khuyên dùng: Neon + Render)

### Bước 1 — Tạo Database PostgreSQL miễn phí trên Neon
1. Vào **https://neon.tech** → Đăng ký tài khoản miễn phí (không cần thẻ tín dụng)
2. Tạo 1 Project mới → Neon tự tạo sẵn 1 database
3. Vào **Connection Details**, copy chuỗi **Connection string** (dạng `postgres://user:pass@host/dbname?sslmode=require`) — đây chính là `DATABASE_URL` bạn sẽ dùng ở bước sau

### Bước 2 — Đưa code lên GitHub
1. Tạo 1 repository mới trên **https://github.com** (có thể để Private)
2. Upload toàn bộ thư mục `khapkhun-solo` này lên repo đó
   (Cách dễ nhất nếu không quen Git: vào trang repo → "Add file" → "Upload files" → kéo thả toàn bộ các file/folder vào)

### Bước 3 — Deploy lên Render
1. Vào **https://render.com** → Đăng ký miễn phí, đăng nhập bằng GitHub
2. Bấm **New** → **Web Service** → chọn repo vừa tạo ở Bước 2
3. Điền cấu hình:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. Vào mục **Environment** → thêm các biến môi trường:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | (chuỗi connection string lấy từ Neon ở Bước 1) |
   | `JWT_SECRET` | một chuỗi bí mật bất kỳ, càng dài càng tốt, ví dụ: `khapkhun-2026-bi-mat-xyz789` |
   | `ADMIN_USERNAME` | `admin` (hoặc tên bạn muốn) |
   | `ADMIN_PASSWORD` | mật khẩu Quản lý đầu tiên, ví dụ: `MatKhauManh123` |
   | `SUPERADMIN_USERNAME` | tên tài khoản sẽ giữ quyền Super Admin vĩnh viễn (thường trùng `ADMIN_USERNAME` lúc đầu) |
   | `BTP_PASS_KHAPKHUN_INIT` | mật khẩu khởi tạo cho file BTP, ví dụ: `doimatkhaunay-kk` (đổi lại trong app ngay sau khi deploy) |
5. Bấm **Create Web Service** — Render sẽ tự build và chạy. Sau ~2-3 phút, bạn sẽ có 1 đường link dạng `https://khapkhun-xxxx.onrender.com`
6. Mở link đó → đăng nhập bằng `ADMIN_USERNAME` / `ADMIN_PASSWORD` vừa đặt → vào app như bình thường

> ⚠️ **Lưu ý gói Free của Render**: nếu không có ai truy cập trong ~15 phút, server sẽ "ngủ" và lần mở tiếp theo sẽ mất khoảng 30-50 giây để "thức dậy". Dữ liệu **không bị mất** khi server ngủ — Postgres trên Neon vẫn lưu trữ độc lập 24/7. Nếu cần server luôn sẵn sàng (không có độ trễ thức dậy), bạn có thể nâng cấp gói trả phí của Render sau (~7 USD/tháng).

### Bước 4 — Tạo tài khoản cho nhân viên
1. Đăng nhập bằng tài khoản Quản lý
2. Vào tab **👤 Người Dùng** (chỉ Quản lý mới thấy tab này)
3. Bấm **+ Thêm Người Dùng** → nhập tên, tài khoản, mật khẩu, chọn vai trò (Nhân viên hoặc Quản lý)
4. Gửi tài khoản/mật khẩu đó cho nhân viên — họ vào cùng link Render để đăng nhập từ điện thoại/máy tính của họ

---

## 3. Chạy thử ở máy tính cá nhân (trước khi deploy, không bắt buộc)

Cần cài sẵn **Node.js** (https://nodejs.org) và 1 database PostgreSQL (có thể dùng luôn Neon ở Bước 1, không cần cài Postgres ở máy).

```bash
cd khapkhun-solo
npm install
cp .env.example .env
# Mở file .env, điền DATABASE_URL / JWT_SECRET / ADMIN_USERNAME / ADMIN_PASSWORD
npm start
```

Sau đó mở trình duyệt vào `http://localhost:3000`.

---

## 4. Vai trò & phân quyền

| | Super Admin | Quản Lý (admin) | Nhân viên (staff/bep/phucvu/thungan) |
|---|---|---|---|
| Dùng toàn bộ các tab nghiệp vụ (Bán Hàng, NVL, Menu, Kho, Chấm Công, Chi Phí, Báo Cáo...) | ✅ | ✅ | ✅ (theo tab được cấp) |
| Xem/thêm/xoá tài khoản người dùng | ✅ | ✅ (không tạo/xoá được tài khoản Quản Lý) | ❌ |
| Tạo/hạ quyền tài khoản Quản Lý (role=admin) | ✅ | ❌ | ❌ |
| Đổi mật khẩu Super Admin không cần mật khẩu cũ (mục Bảo Mật File BTP) | ✅ | ❌ | ❌ |
| Đổi mật khẩu của chính mình | ✅ | ✅ | ✅ |

> Super Admin duy nhất được cố định qua biến môi trường `SUPERADMIN_USERNAME` (xem Bước 3) — dù có bao nhiêu tài khoản Quản Lý khác, chỉ tài khoản trùng đúng username này giữ quyền Super Admin.

---

## 5. Cách hoạt động đồng bộ nhiều người dùng

- Toàn bộ dữ liệu (NVL, Menu, Bán hàng, Kho, Chấm công, Chi phí, Báo cáo...) được lưu **chung 1 nơi** trên database server, không còn lưu riêng theo từng trình duyệt.
- Khi 1 người bấm **💾 Lưu** (hoặc hệ thống tự lưu sau mỗi 2 phút), dữ liệu được đẩy lên server, rồi server **báo ngay cho tất cả thiết bị khác đang mở app** để tự cập nhật màn hình — không cần bấm F5.
- Mỗi thiết bị vẫn giữ 1 **bản sao lưu tạm trên máy** (`localStorage`) để phòng trường hợp mất mạng tạm thời — chấm tròn 🟢/🔴 ở góc phải thanh menu cho biết tình trạng kết nối server.
- Vì dữ liệu dùng chung, nếu 2 người cùng sửa **đúng cùng 1 mục** trong vòng vài giây, người lưu sau sẽ ghi đè người lưu trước (giống Google Sheets khi 2 người gõ cùng 1 ô cùng lúc). Với quy mô vài nhân viên thao tác không liên tục như quán ăn, trường hợp này hiếm khi xảy ra; nếu cần khoá chỉnh sửa theo từng mục để tránh hoàn toàn việc ghi đè, có thể nâng cấp thêm sau.

---

## 6. Bảo mật cần làm ngay sau khi deploy

1. Đăng nhập bằng tài khoản admin mặc định → vào **Người Dùng** → **Đổi Mật Khẩu Của Tôi** → đặt mật khẩu mới mạnh hơn
2. Không chia sẻ `JWT_SECRET` hay `DATABASE_URL` cho người ngoài
3. Mỗi nhân viên nên có 1 tài khoản riêng (không dùng chung 1 tài khoản) để dễ theo dõi ai thao tác gì
