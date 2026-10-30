# Ảnh sản phẩm

Đặt ảnh thật vào thư mục này. Tên file phải bắt đầu bằng mã sản phẩm:

- `wf-01.jpg`
- `wf-02-nau.jpg`, `wf-02-den.jpg` (nhiều màu của cùng mẫu)
- `wf-03.png`, `wf-04.png`, ...

Hỗ trợ JPG, PNG, WebP, GIF. Khi khách hỏi ảnh, bot gửi tối đa 4 ảnh khớp mã
(và lọc theo màu nếu khách nêu màu).

Các file trong thư mục này được serve công khai tại
`${WEBHOOK_PUBLIC_URL}/images/<tên-file>` để Meta tải ảnh khi gửi tin nhắn.
Chỉ đặt ảnh sản phẩm ở đây — không đặt file riêng tư.

Các ảnh hiện tại là **placeholder có chữ "ẢNH MẪU"**. Hãy thay bằng ảnh thật
trước khi tư vấn khách hàng thật.
