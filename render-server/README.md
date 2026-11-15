# SmartBoard 86 Locker — Markaziy Render Server va Telegram Bot

Ushbu server **SmartBoard 86" Doska** ilovasi uchun markaziy boshqaruv markazidir.
2 ta yoki 50 ta doska bo'lganda ham Telegram Bot bitta joyda (Render serverida) xatosiz ishlaydi va Telegram API 409 Conflict ("terminated by other getUpdates request") xatosi butunlay bartaraf etiladi.

---

## Render.com ga O'rnatish (3 qadamda)

### 1-qadam: GitHub ga yuklash
1. Ushbu `render-server` papkasini GitHub omboriga (repository) yuklang.

### 2-qadam: Render.com da Web Service ochish
1. [render.com](https://render.com) saytiga kiring.
2. **"New +"** tugmasini bosing -> **"Web Service"** ni tanlang.
3. GitHub repository-ni tanlang (Connect).
4. Quyidagi parametrlarni kiriting:
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`

### 3-qadam: Environment Variables (O'zgaruvchilar)
**Environment Variables** bo'limiga quyidagilarni kiriting:
- `TELEGRAM_BOT_TOKEN`: Telegram BotFather bergan bot tokeningiz
- `SUPER_ADMIN_ID`: `8453381252`

So'ng **"Create Web Service"** tugmasini bosing.

---

## Doskada (APK) Sozlash:

1. Doskani yoqing va qulflangan ekranda chap yuqori burchakni 3 soniya bosib turing (Standart PIN: `1234`).
2. **"Sozlamalar"** (Settings) bo'limiga o'ting.
3. **"Ulanish usuli"** ni **"Render Server"** qilib belgilang.
4. **"Render Server Manzili"** ga Render URL manzilini kiriting (standart: `https://mukamal-doska.onrender.com`).
5. **"Server aloqasini tekshirish"** tugmasini bosing — server va Telegram bot holati ko'rsatiladi.
6. **"Saqlash"** tugmasini bosing.

Endi Telegram botda har bir xona doskasini alohida yoki barchasini birga boshqarish mumkin.
