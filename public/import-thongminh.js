// ═══════════════════════════════════════════════════════════════
// 📁 IMPORT THÔNG MINH — tự đọc Bill NVL / Chi Phí / Hủy Hàng / Chấm Công
// từ file Excel, ảnh (OCR) hoặc PDF, rồi đồng bộ vào đúng tab.
// File này CHẠY SAU script chính (cần S, saveData, mkey, sortAZ, fmt...
// đã tồn tại trong window khi các hàm bên dưới thực sự được gọi).
// ═══════════════════════════════════════════════════════════════

let _impLoai = 'nvl';          // nvl | chiphi | huyhang | chamcong | taicho | banhang
let _impRows = [];             // các dòng đã parse, đang chờ xem trước / sửa / lưu
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
// Trả về NVL khớp nhất trong S.nvl (hoặc null nếu không đủ giống)
function impMatchNVL(ten) {
  const q = impNormalize(ten);
  if (!q) return null;
  let exact = S.nvl.find(n => impNormalize(n.ten) === q);
  if (exact) return exact;
  let best = null, bestScore = 0;
  for (const n of S.nvl) {
    const cand = impNormalize(n.ten);
    const dist = impLevenshtein(q, cand);
    const score = 1 - dist / Math.max(q.length, cand.length, 1);
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return bestScore >= 0.72 ? best : null;
}
function impMatchStaff(ten) {
  const q = impNormalize(ten);
  if (!q) return null;
  let exact = (S.staff || []).find(n => impNormalize(n.ten) === q);
  if (exact) return exact;
  let best = null, bestScore = 0;
  for (const n of (S.staff || [])) {
    const cand = impNormalize(n.ten);
    const dist = impLevenshtein(q, cand);
    const score = 1 - dist / Math.max(q.length, cand.length, 1);
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return bestScore >= 0.72 ? best : null;
}

// ── Chuẩn hoá ngày về YYYY-MM-DD, hỗ trợ dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd ──
function impParseDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
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

function impMatchMonIn(list, ten) {
  const q = impNormalize(ten);
  if (!q) return null;
  let exact = (list || []).find(m => impNormalize(m.ten) === q);
  if (exact) return exact;
  let best = null, bestScore = 0;
  for (const m of (list || [])) {
    const cand = impNormalize(m.ten);
    const dist = impLevenshtein(q, cand);
    const score = 1 - dist / Math.max(q.length, cand.length, 1);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return bestScore >= 0.72 ? best : null;
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
    banhang: '🛒 Sẽ đọc: tên món, số lượng bán → cộng vào tab Bán Hàng / Menu Tại Chỗ theo đúng ngày (tự dò khớp món ở cả 2 nơi).'
  };
  if (hintEl) hintEl.textContent = hints[_impLoai] || '';
  _impRows = [];
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
  if (statusEl) statusEl.textContent = `✅ Đã đọc xong ${files.length} file — ${_impRows.length} dòng dữ liệu tìm được.${_impUsedFallback ? ' ⚠️ File không có dòng tiêu đề rõ ràng nên hệ thống đã TỰ ĐOÁN cột theo dữ liệu — kiểm tra kỹ từng cột bên dưới trước khi lưu!' : ''} Kiểm tra & sửa bên dưới trước khi Lưu.`;
  input.value = '';
  renderImportPreview();
}

// ══════════ ĐỌC EXCEL / CSV (SheetJS) ══════════
const IMP_COL_ALIASES = {
  ngay: ['ngày', 'ngay', 'date'],
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
function impDetectCol(headerRow) {
  const map = {};
  headerRow.forEach((h, idx) => {
    const hn = impNormalize(h);
    if (!hn) return;
    for (const [key, aliases] of Object.entries(IMP_COL_ALIASES)) {
      if (map[key] !== undefined) continue;
      if (aliases.some(a => hn.includes(a))) map[key] = idx;
    }
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
      const monTen = (get('ten_mon') || get('ten') || '').toString().trim();
      const sl = impMoneyToNumber(get('sl'));
      if (monTen && sl) {
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
  return rows.filter(r => r.ten || r.nhan_vien);
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
  return Object.assign({ ngay: '', ten: '', sl: 1, dvt: '', gia: 0, so_tien: 0, ly_do: '', nhom: '', loai: '', nhan_vien: '', gio: 0, ngay_so: null, mon_ten: '', dinh_luong: 0, kho: false, _nha_cung_cap: '' }, fields);
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
    head = `<th>✓</th><th>Nhân Viên</th><th>Khớp NV</th><th>Ngày</th><th>Số Giờ</th><th>Nguồn File</th><th></th>`;
    body = _impRows.map((r, i) => {
      const match = impMatchStaff(r.nhan_vien);
      return `<tr>
        <td><input type="checkbox" ${r._include ? 'checked' : ''} onchange="impRowSet(${i},'_include',this.checked)"></td>
        <td><input value="${r.nhan_vien || ''}" style="width:150px" onchange="impRowSet(${i},'nhan_vien',this.value)"></td>
        <td>${match ? `✅ ${match.ten}` : `<span style="color:var(--amber)">🆕 NV mới</span>`}</td>
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
    head = `<th>✓</th><th>Ngày</th><th>Tên NVL</th><th>Khớp NVL</th><th>SL</th><th>ĐVT</th><th>Đơn Giá</th>${showLyDo ? '<th>Lý Do</th>' : ''}<th>Nguồn File</th><th></th>`;
    body = _impRows.map((r, i) => {
      const match = impMatchNVL(r.ten);
      return `<tr>
        <td><input type="checkbox" ${r._include ? 'checked' : ''} onchange="impRowSet(${i},'_include',this.checked)"></td>
        <td><input type="date" value="${r.ngay || ''}" style="width:130px" onchange="impRowSet(${i},'ngay',this.value)"></td>
        <td><input list="imp-nvl-datalist" value="${r.ten || ''}" style="width:160px" onchange="impRowSet(${i},'ten',this.value)"></td>
        <td>${match ? `✅ ${match.ten}` : `<span style="color:var(--amber)">🆕 NVL mới (${guessNhomNVL(r.ten)})</span>`}</td>
        <td><input type="number" value="${r.sl || 0}" style="width:70px" onchange="impRowSet(${i},'sl',parseFloat(this.value)||0)"></td>
        <td><input value="${r.dvt || match?.dvt || ''}" style="width:60px" onchange="impRowSet(${i},'dvt',this.value)"></td>
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
    <div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="mt12 flex-center" style="gap:8px">
      <button class="btn btn-teal" onclick="saveAllImportRows()">💾 Lưu Tất Cả Vào Hệ Thống</button>
      <button class="btn btn-outline" onclick="_impRows=[];renderImportPreview();">✖ Xoá Bảng Xem Trước</button>
    </div>`;
}
function impRowSet(i, field, val) { if (_impRows[i]) { _impRows[i][field] = val; if (['ten', 'sl', 'gia', 'mon_ten', '_target'].includes(field)) renderImportPreview(); } }
function impRemoveRow(i) { _impRows.splice(i, 1); renderImportPreview(); }

// ── 🏠 Xem trước: Chart Món / Công Thức (nhóm theo tên món) ──
function renderImportPreviewTaiCho(el) {
  const nvlOpts = sortAZ(S.nvl).map(n => `<option value="${n.ten}">`).join('');
  const groups = {};
  _impRows.forEach((r, i) => { (groups[r.mon_ten] = groups[r.mon_ten] || []).push(i); });

  const body = Object.entries(groups).map(([monTen, idxs]) => {
    const match = impMatchMonIn(S.menu_taicho, monTen);
    const oldCount = match ? (match.nguyen_lieu || []).length : 0;
    const rows = idxs.map(i => {
      const r = _impRows[i];
      const nvlMatch = impMatchNVL(r.ten);
      return `<tr>
        <td><input type="checkbox" ${r._include ? 'checked' : ''} onchange="impRowSet(${i},'_include',this.checked)"></td>
        <td><input list="imp-nvl-datalist" value="${r.ten || ''}" style="width:160px" onchange="impRowSet(${i},'ten',this.value)"></td>
        <td>${nvlMatch ? `✅ ${nvlMatch.ten}` : `<span style="color:var(--amber)">🆕 NVL mới</span>`}</td>
        <td><input type="number" value="${r.dinh_luong || 0}" style="width:80px" onchange="impRowSet(${i},'dinh_luong',parseFloat(this.value)||0)"></td>
        <td><input value="${r.dvt || nvlMatch?.dvt || ''}" style="width:70px" onchange="impRowSet(${i},'dvt',this.value)"></td>
        <td><button class="btn btn-outline btn-sm" onclick="impRemoveRow(${i})">🗑</button></td>
      </tr>`;
    }).join('');
    return `<div class="mb12" style="border:1.5px solid var(--border);border-radius:4px;overflow:hidden">
      <div style="padding:8px 12px;background:${match ? '#fff8f0' : '#f0fdf4'};display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <strong>${monTen}</strong>
        <span class="fs11">${match ? `⚠️ Món đã có trong Menu Tại Chỗ — sẽ <strong>THAY THẾ</strong> công thức cũ (${oldCount} nguyên liệu → ${idxs.length} nguyên liệu mới)` : `🆕 Món mới — sẽ tạo trong Menu Tại Chỗ`}</span>
      </div>
      <div class="tbl-wrap"><table><thead><tr><th>✓</th><th>Tên NVL</th><th>Khớp NVL</th><th>Định Lượng</th><th>ĐVT</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <datalist id="imp-nvl-datalist">${nvlOpts}</datalist>
    <div class="alert alert-info mb8 fs12">📋 Tìm được công thức cho <strong>${Object.keys(groups).length}</strong> món (${_impRows.length} dòng nguyên liệu). Kiểm tra kỹ định lượng trước khi lưu — mỗi món khớp tên có sẵn sẽ bị GHI ĐÈ công thức cũ.</div>
    ${body}
    <div class="mt12 flex-center" style="gap:8px">
      <button class="btn btn-teal" onclick="saveAllImportRows()">💾 Lưu Tất Cả Vào Hệ Thống</button>
      <button class="btn btn-outline" onclick="_impRows=[];renderImportPreview();">✖ Xoá Bảng Xem Trước</button>
    </div>`;
}

// ── 🛒 Xem trước: Báo Cáo Bán Hàng (tự dò khớp món ở cả 2 nơi) ──
function renderImportPreviewBanHang(el) {
  const allMonOpts = sortAZ([...S.menu.map(m => m.ten), ...S.menu_taicho.map(m => m.ten)].filter((v, i, a) => a.indexOf(v) === i).map(ten => ({ ten }))).map(m => `<option value="${m.ten}">`).join('');
  const body = _impRows.map((r, i) => {
    const tc = impMatchMonIn(S.menu_taicho, r.mon_ten);
    const ap = !tc ? impMatchMonIn(S.menu, r.mon_ten) : null;
    if (r._target === undefined) r._target = tc ? 'taicho' : (ap ? 'menu' : 'skip');
    const matchLabel = tc ? `✅ Tại Chỗ: ${tc.ten}` : ap ? `✅ Bán Hàng (App): ${ap.ten}` : `❓ Chưa khớp món — vui lòng chọn tay`;
    return `<tr>
      <td><input type="checkbox" ${r._include ? 'checked' : ''} onchange="impRowSet(${i},'_include',this.checked)"></td>
      <td><input list="imp-mon-datalist" value="${r.mon_ten || ''}" style="width:170px" onchange="impRowSet(${i},'mon_ten',this.value)"></td>
      <td class="fs11">${matchLabel}</td>
      <td><select onchange="impRowSet(${i},'_target',this.value)">
        <option value="taicho" ${r._target === 'taicho' ? 'selected' : ''}>🏠 Menu Tại Chỗ</option>
        <option value="menu" ${r._target === 'menu' ? 'selected' : ''}>🛒 Bán Hàng (App)</option>
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
    <div class="alert alert-info mb8 fs12">📋 Tìm được <strong>${_impRows.length}</strong> dòng bán hàng. Hệ thống tự dò khớp món ở cả Menu Tại Chỗ và Bán Hàng (App) — kiểm tra cột "Khớp Món" và chọn lại đích nếu cần, số lượng sẽ GHI ĐÈ (thay thế) số đã có trong ngày đó.</div>
    <div class="tbl-wrap"><table><thead><tr><th>✓</th><th>Tên Món</th><th>Khớp Món</th><th>Lưu Vào</th><th>Ngày</th><th>SL Bán</th><th>Khô?</th><th>Nguồn File</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="mt12 flex-center" style="gap:8px">
      <button class="btn btn-teal" onclick="saveAllImportRows()">💾 Lưu Tất Cả Vào Hệ Thống</button>
      <button class="btn btn-outline" onclick="_impRows=[];renderImportPreview();">✖ Xoá Bảng Xem Trước</button>
    </div>`;
}

// ══════════ LƯU VÀO HỆ THỐNG ══════════
function saveAllImportRows() {
  const rows = _impRows.filter(r => r._include);
  if (!rows.length) { alert('Không có dòng nào được chọn để lưu!'); return; }
  let added = 0;

  if (_impLoai === 'nvl' || _impLoai === 'huyhang') {
    rows.forEach(r => {
      if (!r.ten || !r.ngay) return;
      let nvl = impMatchNVL(r.ten);
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
      let nv = impMatchStaff(r.nhan_vien);
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
        let nvl = impMatchNVL(r.ten);
        if (!nvl) {
          const newId = Math.max(0, ...S.nvl.map(n => n.id), 0) + 1;
          nvl = { id: newId, ten: r.ten.trim(), dvt: r.dvt || 'kg', gia: 0, gia_chuan: 0, gia_chuan_ngay: new Date().toISOString().slice(0, 10), gia_chuan_auto: false, nhom: guessNhomNVL(r.ten), khong_quan_ly_ton: false };
          S.nvl.push(nvl);
        }
        return { ten: nvl.ten, dvt_nvl: r.dvt || nvl.dvt, dinh_luong: r.dinh_luong || 0 };
      });
      if (!nguyenLieu.length) return;
      let mon = impMatchMonIn(S.menu_taicho, monTen);
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
    rows.forEach(r => {
      if (r._target === 'skip' || !r.mon_ten || !r.sl) return;
      const ngay = r.ngay || new Date().toISOString().slice(0, 10);
      const parts = ngay.split('-');
      const nam = parseInt(parts[0]), thang = parseInt(parts[1]), day = parseInt(parts[2]);
      if (!day) return;
      const mk = mkey(thang, nam);
      const mon = r._target === 'taicho' ? impMatchMonIn(S.menu_taicho, r.mon_ten) : impMatchMonIn(S.menu, r.mon_ten);
      if (!mon) return; // Chưa khớp món & chưa chọn tay đích → bỏ qua, không tự tạo món mới từ báo cáo bán hàng
      let key = r._target === 'taicho' ? 'tc_' + mon.id : String(mon.id);
      if (r.kho) key += '_kho';
      if (!S.ban_hang[mk]) S.ban_hang[mk] = {};
      if (!S.ban_hang[mk][key]) S.ban_hang[mk][key] = {};
      S.ban_hang[mk][key][String(day)] = r.sl;
      added++;
    });
  }

  saveData();
  _impRows = [];
  renderImportPreview();
  const statusEl = document.getElementById('imp-status');
  if (statusEl) statusEl.textContent = `✅ Đã lưu ${added} dòng vào hệ thống! Vào tab tương ứng để kiểm tra.`;
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
