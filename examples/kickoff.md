# Tin kickoff: dán vào ô chat trên web, người nhận `@all`

Thay `PROJ-123` bằng mã ticket. Các dòng trong ngoặc vuông là tuỳ chọn.

---

🎫 **Kickoff ticket PROJ-123**

Đọc ticket **TLPORTAL-10182** trên Backlog (mô tả, AC, comment, file đính kèm) và dùng bridge xem design sau https://www.figma.com/design/r8Vr9f9sN9f4NdYOWhmh8X/L-%C3%A9quipe-de-nguyen.van.son-team-library?node-id=3451-1404&t=mIBA22bv8kQe3G21-4 rồi chạy quy trình B1 → B7.

- **@dev**: B1 viết plan `docs/plan/PROJ-123.md` → B2 review test case của QA → B3 implement + unit test → B4 chạy app, handoff URL cho QA → B5–B6 fix hoặc phản biện bug.
- **@qa**: B1 viết test case `qa/testcases/PROJ-123.md` → B2 review plan của DEV → B3 soát code, báo lệch AC sớm → B5–B6 test trên browser, báo bug, retest.
- **B7**: QA soạn nháp tổng kết, DEV bổ sung phần kỹ thuật, rồi gửi tôi **1 báo cáo chung**.

Luật: mỗi vấn đề tranh luận tối đa 2 lượt mỗi bên, sau đó hỏi tôi phân xử. Mọi lý lẽ phải trích AC. Không sửa ticket trên Backlog.
[App chạy bằng: `npm run dev` → http://localhost:8888 · Tài khoản test: 100000 / Password_1]

Trước khi bắt đầu, mỗi người trả lời tôi 1 tin ngắn: bạn hiểu ticket thế nào, AC nào còn mơ hồ.
