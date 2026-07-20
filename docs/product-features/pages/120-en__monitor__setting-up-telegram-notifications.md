---
title: "Setting Up Telegram Notifications"
source_url: "https://docs.xxyy.io/en/monitor/setting-up-telegram-notifications"
source_markdown_url: "https://docs.xxyy.io/en/monitor/setting-up-telegram-notifications.md"
language: "en"
category: "English documentation"
section: "English / Monitor"
lastmod: "2025-09-14T17:12:38.592Z"
retrieved_at: "2026-07-19T14:24:48.800Z"
content_state: "content"
ingest: true
---

# Setting Up Telegram Notifications

⚠️IMPORTANT: To protect your funds, please use ONLY the official XXYY bot to get your Group ID: [https://t.me/XXYYgetidBot](https://www.google.com/url?sa=E\&q=https%3A%2F%2Ft.me%2FXXYYgetidBot). Beware of imposter bots that may be scams.

Step 1: Create a Telegram Group & Add Our Bot

1. Open Telegram and create a New Group.
2. Give your group a name (e.g., "XXYY Alerts").
3. In the "Add Members" search bar, type @XXYYgetidBot and select our official bot.
4. Finish creating the group.
5. CRITICAL: You must promote our bot to an administrator. Go to Group Settings > Administrators > Add Admin, and select the XXYYgetidBot.

Step 2: Create Your Own Personal Bot

This bot will be responsible for sending the actual alert messages to your group.

1. Open a direct message with @BotFather on Telegram.
2. Type the command /newbot and send it.
3. Follow the prompts to set a display name and a unique username for your bot.
4. BotFather will reply with a message containing your HTTP API token. This token is secret and essential. Copy and save it securely.
5. Go back to the XXYY website and paste this API token into the designated field.
6. Finally, go to your Telegram group, add a member, and add your newly created personal bot to the group.

Pro Tip: Telegram has rate limits. We recommend creating several personal bots and rotating their API tokens to ensure you don't miss any alerts.

Step 3: Get Your Group ID & Finalize Setup

1. In the Telegram group you created (which now contains both our official bot and your personal bot), type the command /getgroupid and send it.
2. The official @XXYYgetidBot will reply with your Group ID.
3. IMPORTANT: The Group ID is a long number that starts with a negative sign (-). You must copy the entire ID, including the negative sign.
4. Go back to the XXYY website and paste this Group ID into the designated field.
5. Click the "Test" button to send a test notification. If you receive it in your Telegram group, the configuration is successful!

Troubleshooting & Notes:

* If you cannot get the Group ID, double-check that the @XXYYgetidBot has been successfully promoted to an administrator in your group.
* If you stop receiving notifications, check your Telegram group settings to ensure the Group ID has not changed.
