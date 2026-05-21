import os

import httpx
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters


AGENT_API_URL = os.getenv("AGENT_API_URL", "http://localhost:8000")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    del context
    if update.message:
        await update.message.reply_text("Ask me anything about the XXYY docs.")


async def answer(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    del context
    if not update.message or not update.message.text:
        return

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{AGENT_API_URL}/chat",
            json={"question": update.message.text},
        )
        response.raise_for_status()
        payload = response.json()

    citations = payload.get("citations", [])
    source_lines = "\n".join(f"- {item['title']}: {item['url']}" for item in citations)
    text = payload["answer"]
    if source_lines:
        text = f"{text}\n\nSources:\n{source_lines}"

    await update.message.reply_text(text)


def build_application() -> Application:
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, answer))
    return app


def main() -> None:
    build_application().run_polling()


if __name__ == "__main__":
    main()

