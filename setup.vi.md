# Hướng dẫn setup Facebook / Messenger (tiếng Việt)

Tài liệu này hướng dẫn từng bước tạo Meta app, lấy **App ID / App Secret / Page ID / Page token**, bật webhook, **Go Live** và cấu hình **Conversation Routing** để bot trả lời khách.

> Bản tiếng Anh đầy đủ: [README.md](README.md) — Part A → Part D.
> Nếu chỉ muốn chạy nhanh: làm mục 1 → 9, sau đó mục 7 (Tailscale) và mục 12 (chạy bot).

---

## 0. Chuẩn bị

- Tài khoản Facebook là **admin** của Page.
- Tài khoản Meta Developer: mở https://developers.facebook.com và chấp nhận điều khoản.
- Dùng **máy tính** — nhiều mục không có trên app điện thoại.
- Page đã tạo sẵn.

---

## 1. Tạo Meta app — lấy App ID + App Secret

1. Mở https://developers.facebook.com/apps/ → **Create app**.
2. Use case: **Business** → **Next**.
3. Nhập tên app (ví dụ `Shop Sales Bot`), email liên hệ → **Create app**.
4. **App ID** hiển thị trên dashboard → điền vào `META_APP_ID` trong `.env`.
5. **App Secret:** App Dashboard → **App settings → Basic** → **App secret** → **Show** → điền vào `META_APP_SECRET`.

---

## 2. Thêm Messenger và kết nối Page — lấy Page token

1. App Dashboard → **Add products to your app** → **Messenger** → **Set up**.
2. **Messenger → Settings → Access Tokens** → **Add or Remove Pages**.
3. Chọn Page → **Allow**.
4. Bấm **Generate Token** cạnh Page → copy → đây là `META_PAGE_TOKEN`.

> Token phải là **PAGE token**, không phải **USER token**. USER token chỉ đọc được Page, không subscribe được Page và không gửi tin được — `subscribed_apps` sẽ báo `Invalid OAuth 2.0 Access Token`.

---

## 3. Lấy Page ID

Ba cách, tất cả phải cho **cùng một số**:

- Page → **About** → **Page transparency** → **Page ID**.
- Graph API: `GET /me/accounts?fields=id,name` bằng user token.
- Trường `profile_id` từ `debug_token` (xem mục 5).

> **Page ID phải trùng `profile_id` của token.** Nếu lệch, Graph API trả về:
> `(#100) Unsupported get request… Object with ID … does not exist`
> (`error_subcode: 33`). Đây là lỗi “page ID” phổ biến nhất.

---

## 4. Lấy Page token vĩnh viễn và đủ quyền

### Cách 1 — Messenger dashboard (dễ nhất)

**Messenger → Settings → Access Tokens → Add or Remove Pages → Generate Token.**
Dán token vào https://developers.facebook.com/tools/debug/accesstoken/ và kiểm tra **Expires: Never**.

### Cách 2 — Graph API Explorer (khi thiếu scope hoặc cần token vĩnh viễn)

1. Mở https://developers.facebook.com/tools/explorer/
2. Chọn app của bạn.
3. Thêm các quyền: `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging`.
4. Bấm **Generate Access Token** → đăng nhập → cấp quyền.
5. Đổi user token ngắn hạn sang long-lived:
   ```
   GET https://graph.facebook.com/v23.0/oauth/access_token
       ?grant_type=fb_exchange_token
       &client_id=<META_APP_ID>
       &client_secret=<META_APP_SECRET>
       &fb_exchange_token=<SHORT_USER_TOKEN>
   ```
6. Gọi `GET /me/accounts?fields=id,name,access_token` bằng long-lived token.
   Copy `access_token` của Page — `expires_at` phải là `0` (vĩnh viễn).
7. Điền token đó vào `META_PAGE_TOKEN`.

> `pages_read_engagement` là tuỳ chọn (chỉ để hiển thị tên Page).
> `pages_messaging` và `pages_manage_metadata` là **bắt buộc**.

---

## 5. Kiểm tra token

Mở https://developers.facebook.com/tools/debug/accesstoken/, dán token → **Debug**. Kết quả phải có:

| Trường | Giá trị đúng |
|---|---|
| Type | **PAGE** |
| Profile ID | đúng `META_PAGE_ID` |
| Expires | **Never** (`expires_at: 0`) |
| Scopes | `pages_messaging`, `pages_manage_metadata` (+ `pages_read_engagement` nếu có) |

Hoặc kiểm tra bằng terminal:

```bash
curl -sG "https://graph.facebook.com/v23.0/debug_token" \
  --data-urlencode "input_token=$META_PAGE_TOKEN" \
  --data-urlencode "access_token=$META_APP_ID|$META_APP_SECRET"
```

Các lỗi thường gặp:

- `type: USER` → đang dùng user token, phải đổi sang Page token.
- Thiếu `pages_manage_metadata` → bước subscribe Page sẽ lỗi `(#200)`.
- Thiếu `pages_read_engagement` → chỉ không hiện tên Page; code có fallback nên bot vẫn chạy.

---

## 6. Điền `.env`

```bash
cp .env.example .env
```

| Biến | Lấy từ đâu |
|---|---|
| `META_PAGE_ID` | Mục 3 |
| `META_PAGE_TOKEN` | Mục 4 — PAGE token, vĩnh viễn |
| `META_APP_ID` | Mục 1 |
| `META_APP_SECRET` | Mục 1 |
| `META_VERIFY_TOKEN` | Tự đặt chuỗi ngẫu nhiên (≥ 6 ký tự), dùng lại khi đăng ký webhook |
| `WEBHOOK_PUBLIC_URL` | Mục 7 |

Các biến khác: `BOT_PROVIDER`, `ANTHROPIC_API_KEY` hoặc `DEEPSEEK_API_KEY`, `OWNER_SETUP_CODE`, `PORT`.

---

## 7. URL HTTPS công khai (Tailscale Funnel)

Meta phải truy cập được máy Mac qua HTTPS.

1. Cài Tailscale: https://tailscale.com/download/mac → đăng nhập.
2. Vào https://login.tailscale.com/admin/dns → bật **MagicDNS** và **HTTPS Certificates**.
3. Trong *System Settings → Privacy & Security → Local Network*, cho phép Tailscale.
4. Chạy Funnel nền:
   ```bash
   tailscale funnel --bg 3000
   ```
   Lần đầu có thể mở trình duyệt để xác nhận. Lệnh in ra URL dạng
   `https://your-mac.tailnet-abc123.ts.net`.
5. Kiểm tra:
   ```bash
   tailscale funnel status
   curl -sS https://<your-url>/health
   ```
   Phải thấy `Funnel on`, proxy `http://127.0.0.1:3000`; `/health` trả JSON khi bot
   (hoặc server tạm của `npm run setup`) đang chạy.
6. Điền URL (không có dấu `/` cuối) vào `WEBHOOK_PUBLIC_URL`.

> Lỗi `SSL_ERROR_SYSCALL` khi setup = Funnel chưa chạy hoặc HTTPS Certificates chưa bật.

---

## 8. Go Live

1. Mở `https://developers.facebook.com/apps/<META_APP_ID>/go_live/`
   (hoặc App Dashboard → thanh trên → **App Mode → Live**).
2. Trước khi cho chuyển, điền **App settings → Basic**:
   - **App icon**: PNG 1024×1024.
   - **Privacy Policy URL**: trang HTTPS công khai, không cần đăng nhập.
     Nếu Meta từ chối URL Page, tạo Google Doc → *Share → Anyone with the link*.
   - **Terms of Service URL**: tương tự.
   - **User Data Deletion**: chọn *Data Deletion Instructions URL* — dùng cùng trang.
   - **Category**: *Business and Pages* hoặc *Shopping & Retail*.
   - **Contact email**.
   - Bấm **Save changes**.
3. Quay lại trang go-live → **Live** → xác nhận.
4. Nếu bị chặn, hộp thoại sẽ liệt kê field còn thiếu — điền rồi thử lại.

> **Live không phải App Review.** Live mở app cho công chúng, nhưng quyền
> `pages_messaging` vẫn có thể chỉ dùng được cho admin/developer/tester nếu chưa
> có **Advanced Access** (mục 10).

---

## 9. Conversation Routing — đặt bot làm default app (bắt buộc)

Nếu bỏ qua bước này, **Page Inbox giữ quyền điều khiển hội thoại**. Bot chỉ nhận
webhook `standby` và phải im lặng; `take_thread_control` lỗi
`(#27) … Conversation Routing not enabled`.

1. Trên facebook.com, bấm avatar → **See all profiles** → chọn Page của bạn.
2. Mở **Page settings → Page setup → Messenger conversation routing**.
   Link trực tiếp: https://www.facebook.com/settings?tab=msgr_conversation_routing
   (phải đang thao tác với tư cách Page).
3. Đặt **Default app / Default routing app** = app bot (ví dụ `Chat bot`).
   - Chưa có: **Set up → Get started** → chọn app → **Continue**.
   - Đang là app khác: **⋯ → Edit** → chọn app → **Save**.
4. Vào **Page setup → Advanced messaging → Connected apps**, chỉnh app và bật
   **Access standby channel** + **Take control of conversations** → **Save**.
5. Cách khác: **Meta Business Suite → Settings → Integrations → Conversation
   routing** → chọn Page → **Routing** → **Set up/Edit**.
6. Kiểm tra:
   ```bash
   curl -sG "https://graph.facebook.com/v23.0/me" \
     --data-urlencode "fields=messaging_feature_status" \
     --data-urlencode "access_token=$META_PAGE_TOKEN"
   ```
   - `hop_v2: true` — routing đã bật.
   - `msgr_multi_app: true` — đã có default app.
   - `msgr_multi_app: false` — **chưa có default app**; bot sẽ chỉ thấy standby.
7. Hội thoại cũ do Page Inbox giữ: mở trong Page Inbox / Meta Business Suite và
   đánh dấu **Done**. Hoặc nhắn `bot tiếp` từ tài khoản owner — bot sẽ cố lấy lại
   quyền và báo số thread lấy được.

> Không thấy menu: dùng máy tính, đúng profile Page, tìm “routing” trong Settings,
> hoặc thử Meta Business Suite. Meta hay đổi tên/di chuyển menu.

---

## 10. Tester và App Review

- **Test ngay, không cần review:** App Dashboard → **App roles → Roles** →
  **Add people → Tester**. Tài khoản test chấp nhận lời mời, sau đó có thể nhắn Page.
- **Khách thật:** App Dashboard → **App Review → Permissions and Features** →
  xin **Advanced Access** cho `pages_messaging` (và `pages_manage_metadata`,
  `pages_show_list` nếu được yêu cầu). Cần privacy policy, screencast ngắn,
  tài khoản test và hướng dẫn từng bước. Có thể cần xác minh doanh nghiệp.

---

## 11. Đăng ký webhook

`npm run setup` tự làm bước này. Nếu làm thủ công:

1. App Dashboard → **Messenger → Settings → Webhooks** → **Add Callback URL**.
2. Callback URL: `https://<your-public-url>/webhook`
3. Verify Token: đúng `META_VERIFY_TOKEN` trong `.env`.
4. **Verify and Save** — bot và Funnel phải đang chạy.
5. **Add subscriptions**: `messages`, `message_deliveries`, `message_echoes`,
   `messaging_handovers`, `standby`, `feed`.
6. **Access Tokens → Add or Remove Pages** → subscribe lại Page.

---

## 12. Chạy bot

```bash
cd ~/Documents/working/fb-sales-bot
cp .env.example .env        # điền theo mục 6
npm install                 # một lần
npm run setup               # kiểm tra token + đăng ký webhook + subscribe Page
npm start                   # hoặc ./start.sh
```

Output mong đợi của `npm run setup`:

```
— 1/4 Verify Page token
✅ Connected to Page "…" (id …)

— 2/4 Register webhook with Meta
✅ Webhook registered: https://…/webhook

— 3/4 Subscribe the Page to webhook fields
✅ Page subscribed (messages, message_echoes, message_handovers, standby, feed)
```

- Bước 2 lỗi → Funnel chưa chạy / `WEBHOOK_PUBLIC_URL` sai (mục 7).
- Bước 3 lỗi → token thiếu `pages_manage_metadata`, hoặc đang là USER token (mục 4/5).

---

## 13. Đăng ký owner

- Trong `.env`, đặt `OWNER_SETUP_CODE` thành mã ngẫu nhiên của bạn.
- Từ **tài khoản Facebook cá nhân**, nhắn đúng mã đó vào Page.
- Bot xác nhận và từ đó gửi thông báo đơn hàng / yêu cầu hỗ trợ về tài khoản đó.

> Tài khoản owner là **tài khoản điều khiển**: bot **không tự trả lời** tin thường
> từ owner. Muốn test hội thoại khách, dùng tài khoản khác (hoặc thêm Tester).

Lệnh owner:

| Tin nhắn | Tác dụng |
|---|---|
| `bot off` | Tạm dừng auto-reply cho tất cả khách |
| `bot on` | Bật lại |
| `bot tiếp` | Resume các hội thoại đang dừng và cố lấy lại quyền từ Page Inbox |
| `đơn 12 đã gửi` | Cập nhật trạng thái đơn #12 |

---

## 14. Sản phẩm, ảnh và quy tắc

- **`knowledge.md`** — sản phẩm, giá, tồn kho, ship, thanh toán, bảo hành, FAQ.
  Bot chỉ dùng thông tin trong file này. Sửa và lưu, không cần restart.
- **`rules.json`** — giảm giá tối đa, ngưỡng free ship, giảm giá số lượng,
  điều không được hứa, điều kiện chuyển chủ shop.
- **`assets/images/`** — ảnh sản phẩm. Đặt tên bắt đầu bằng mã SKU:
  `wf-01.jpg`, `wf-02-nau.jpg`, `wf-02-den.jpg`… Bot gửi tối đa 4 ảnh mỗi lần.
  Ảnh được serve công khai tại `https://<public-url>/images/<tên-file>`.

> Các ảnh hiện tại là placeholder có chữ “ẢNH MẪU”. Thay bằng ảnh thật trước khi
> bán cho khách thật.

---

## 15. Checklist test

1. `npm run test:order` — luồng đơn hàng, SQLite, CSV.
2. `npm run test:claude` / `npm run test:deepseek` — tool loop offline.
3. `DRY_RUN=1 npm start` → test webhook, không tốn credit AI.
4. Từ tài khoản khách (không phải owner), nhắn Page: bot trả lời trong vài giây.
5. Comment “giá bao nhiêu?” lên bài viết: có trả lời công khai + 1 tin nhắn riêng.
6. Chốt một đơn: kiểm tra `data/orders.csv` và thông báo owner.
7. Nhắn “cho xem ảnh WF-02”: bot gửi ảnh.
8. Trả lời khách từ Page Inbox: bot im lặng; nhắn `bot tiếp` để lấy lại.

---

## 16. Lỗi thường gặp

| Lỗi / hiện tượng | Cách xử lý |
|---|---|
| `(#100) Unsupported get request… Object with ID … does not exist` | `META_PAGE_ID` không khớp `profile_id` của token. Kiểm tra mục 3/5. |
| `Invalid OAuth 2.0 Access Token` khi subscribe | Đang dùng USER token hoặc token hết hạn. Lấy PAGE token mục 4. |
| `(#200) Requires pages_manage_metadata` | Token thiếu scope. Tạo lại token với đủ quyền mục 4. |
| `(#100) … requires pages_read_engagement` | Scope tuỳ chọn thiếu; code có fallback, thêm nếu muốn hiện tên Page. |
| `setup` lỗi bước 2 / `SSL_ERROR_SYSCALL` | Funnel chưa chạy hoặc HTTPS Certificates chưa bật (mục 7). |
| Log `standby event … Page Inbox owns thread` | Page Inbox giữ hội thoại. Đặt default app mục 9, mark Done, hoặc `bot tiếp`. |
| `take_thread_control` lỗi `(#27)` | Chưa có default app trong Conversation Routing (mục 9). |
| Bot không trả lời tin từ owner | Đúng thiết kế. Test bằng tài khoản khách hoặc dùng lệnh owner. |
| App Live nhưng chỉ tester nhận trả lời | Thiếu Advanced Access cho `pages_messaging` (mục 10). |
| Ảnh không gửi được | `WEBHOOK_PUBLIC_URL` phải là HTTPS công khai; mở thử `https://<url>/images/wf-02-nau.png`; tên file phải bắt đầu bằng SKU. |
| `(#10) outside of allowed window` | Quá 24 giờ từ tin cuối của khách. Trả lời thủ công từ Page Inbox. |
| launchd báo `Operation not permitted` | Cấp Full Disk Access cho `/bin/zsh` trong System Settings → Privacy & Security. |

---

## Nguồn tham khảo

- Meta App Modes: https://developers.facebook.com/docs/development/build-and-test/app-modes
- Access Token Debugger: https://developers.facebook.com/tools/debug/accesstoken/
- Graph API Explorer: https://developers.facebook.com/tools/explorer/
- Conversation Routing: https://developers.facebook.com/docs/messenger-platform/conversation-routing
- Meta Business Help — Conversation routing: https://www.facebook.com/business/help/321478556915081
