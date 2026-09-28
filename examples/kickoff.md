# Tin kickoff: dán vào ô chat trên web, người nhận `@all`

Cách nhanh hơn: `tcm start <TICKET>` hoặc nút **🎫 Kickoff** trên web tự soạn tin này từ `.team-hub.json` của repo.

Gửi tay thì thay mã ticket, link Figma và tài khoản test:
- `Figma:` link design dùng THAY cho link trong ticket. Cả DEV và QA đều tự xem bằng figma-console (Desktop Bridge).
  Trước khi gửi: mở file đó trong Figma Desktop và chạy plugin Desktop Bridge.
- `Tài khoản test:` agent dùng để đăng nhập khi chạy app / test, và không ghi mật khẩu vào file trong repo.

---

🎫 **Kickoff ticket PROJ-123**

Đọc ticket **PROJ-123** trên Backlog (mô tả, AC, comment, file đính kèm) và chạy quy trình B1 → B7.
- Figma: https://www.figma.com/design/<fileKey>/<tên>?node-id=1-2 (dùng link này thay cho link trong ticket, xem bằng figma-console)
- Tài khoản test: 100000 / Password_1 (không ghi mật khẩu vào file)
- App: `npm run dev` → http://localhost:8888

- **@dev**: B1 tự xem design + viết plan `docs/plan/PROJ-123.md` → B2 review test case của QA → B3 implement + unit test → B4 chạy app, handoff URL cho QA → B5–B6 fix hoặc phản biện bug.
- **@qa**: B1 tự xem design + viết test case `qa/testcases/PROJ-123.md` → B2 review plan của DEV → B3 soát code, báo lệch AC sớm → B5–B6 test trên browser (so UI với design trên Figma), ghi kết quả `qa/runs/PROJ-123.md`, báo bug, retest.
- **B7**: QA soạn nháp tổng kết, DEV bổ sung phần kỹ thuật, rồi gửi tôi **1 báo cáo chung**.

Luật: mỗi vấn đề tranh luận tối đa 2 lượt mỗi bên, sau đó hỏi tôi phân xử. Mọi lý lẽ phải trích AC. Không sửa ticket trên Backlog.

Trước khi bắt đầu, mỗi người trả lời tôi 1 tin ngắn: bạn hiểu ticket thế nào, AC nào còn mơ hồ.
