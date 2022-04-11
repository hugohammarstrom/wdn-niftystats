require("dotenv").config()
const { handler } = require("./handler");

(async () => {
  await handler()
})()