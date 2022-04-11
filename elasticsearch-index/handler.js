"use strict";
const md5 = require("md5");
const mysql = require("mysql2");
const fetch = require("node-fetch");
const bluebird = require("bluebird")
const moment = require("moment")

const getProgram = (program_id, programs) => {
  const program = programs.find((p) => p.program_id == program_id);
  if (program?.parent_id) {
    return getProgram(program.parent_id, programs) || program;
  } else {
    return program;
  }
};

const CACHED_RATES = new Map()
const BASE_CURRENCY = "SEK"

const getRates = async (date) => {
  date = moment(date)
  const isSameDay = date.isSame(new Date(), "day")
  const isFuture = date.isAfter(new Date(), "day")
  const dateString = (isSameDay || isFuture) ? "latest" : moment(date).format("YYYY-MM-DD")
  let rates = CACHED_RATES.get(dateString)

  if (!rates) {
    const resCurrencyRates = await fetch(`http://api.exchangeratesapi.io/v1/${isSameDay ? "latest" : dateString}?access_key=${process.env.EXCHANGERATESAPI_ACCESS_KEY}`)
    const currencyRates = await resCurrencyRates.json()
    if (currencyRates.error || !currencyRates.success) {
      console.log(currencyRates.error)
      throw new Error("Unable to get exchange rates")
    }

    const usdEurRatio = 1 / currencyRates.rates[BASE_CURRENCY]

    rates = Object.keys(currencyRates.rates).reduce((rates, currency) => {
      if (currency !== BASE_CURRENCY) {
        rates[currency] = currencyRates.rates[currency] * usdEurRatio
      }
      return rates
    }, { EUR: usdEurRatio })

    CACHED_RATES.set(dateString, rates)
  }

  return rates
}

const normalizeAmount = async (amount, currency, rates) => {
  currency = currency.toUpperCase()
  if (currency === BASE_CURRENCY) {
    return amount
  }
  const rate = rates?.[currency]
  return amount / rate
}

const createFormattedStatRecord = async (stat, rates, programs) => {
  const program = getProgram(stat.program_id, programs);
  if (!program) {
    console.log(stat?.program_id);
  }
  return {
    id: md5(`${stat.program_id}${stat.sdate}`),
    ...stat,
    totalamt: await normalizeAmount(Number(stat.totalamt || 0), program.currency, rates),
    program: Object.assign({}, program),
  };
};

const indexRecords = async (records, index) => {
  const data = records.reduce((data, record) => {
    const indexName = `${index}-${moment(record.sdate).format("YYYY-MM")}`
    data = [
      ...data,
      JSON.stringify({ index: { _index: indexName, _id: record.id } }),
      JSON.stringify(record),
    ];
    return data;
  }, []);

  const res = await fetch("https://2f24beec629d496da6fbc2d1fd9a50db.eu-central-1.aws.cloud.es.io:9243/_bulk", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.ELASTICSEARCH_USERNAME}:${process.env.ELASTICSEARCH_PASSWORD}`).toString("base64")}`,
      "Content-Type": 'application/json'
    },
    body: data.join("\n") + "\n"
  })
  console.log(res.status + " - " + res.statusText)
};

module.exports.handler = async (event) => {
  const index =
    "wdn-allan-nifty-stats";

  const connection = mysql.createConnection({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    port: process.env.MYSQL_PORT,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    dateStrings: [
      'DATE',
      'DATETIME'
    ]
  });

  connection.connect();

  console.time("fetch data")

  const date = new Date()
  date.setDate(date.getDate() - 31)

  const dateString = moment(date).format("YYYY-MM-DD")

  console.log("using database host:", connection.config.host)

  console.log(`indexing all records from ${dateString} to present`)

  const [programs] = await connection
    .promise()
    .query("SELECT * from NsPrograms");
  const [stats] = await connection
    .promise()
    .query("SELECT * from NsStats where sdate > ?", dateString);

  console.timeEnd("fetch data")
  connection.end();

  if (stats.length) {
    console.time("generate records");
    const records = []
    for (let i = 0; i < stats.length; i++) {
      const stat = stats[i];
      const rates = await getRates(stat.sdate)
      const formattedRecord = await createFormattedStatRecord(stat, rates, programs);
      records.push(formattedRecord)
    }

    console.timeEnd("generate records");
    console.log("records:", records.length)

    console.time("index records");
    await indexRecords(records, index);
    console.timeEnd("index records");
  }
};
