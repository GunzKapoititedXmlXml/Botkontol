module.exports = {
  BOT_NAME: "𝐁𝐎𝐓 𝐁𝐔𝐈𝐋𝐃 𝐁𝐘 𝐆𝐔𝐍𝐙",
  BOT_VERSION: "𝟏.𝟓.𝟎",
  BOT_TOKEN: process.env.BOT_TOKEN || "8572881982:AAG_y7zsXZByeXa_KrKGiAv1LrBO-bVDbt0",
  ADMIN_IDS: (process.env.ADMIN_IDS || "8212614573").split(",").map(Number).filter(Boolean),

  
  CHANNEL_USERNAME: process.env.CHANNEL_USERNAME || "@infobotbuildgunz",
CHANNEL_USERNAME2: process.env.CHANNEL_USERNAME2 || "@gballpublic",
CHANNEL_USERNAME3: process.env.CHANNEL_USERNAME3 || "@gballpublic",
  
  OWNER_ID: parseInt(process.env.OWNER_ID || "8212614573"),

  WELCOME_PHOTO: process.env.WELCOME_PHOTO || "https://files.catbox.moe/08r499.png",
  NEW_USER: process.env.NEW_USER || "https://files.catbox.moe/08r499.png",
  TMP_DIR: "./tmp",

  BUILD_TIMEOUT_MS: 10 * 60 * 1000,
  POLL_INTERVAL_MS: 5000,       
  WEB2APK_MAINTENANCE: false,
};
