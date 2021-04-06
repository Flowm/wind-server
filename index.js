const express = require("express");
const compression = require("compression");
const moment = require("moment");
const fetch = require("node-fetch");
const fs = require("fs");
const cors = require("cors");
const { exec } = require("child_process");

const app = express();
const grib2json = process.env.GRIB2JSON || "./converter/bin/grib2json";
const port = process.env.PORT || 7000;
const resolution = process.env.RESOLUTION || "0.5";
const baseDir = `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_${resolution === "1" ? "1p00" : "0p50"}.pl`;
const wind = process.env.WIND || true;
const temp = process.env.TEMP || false;

// GFS model update cycle
const GFS_CYCLE_H = 6;

// GFS model forecast timestep
const GFS_FORECAST_H = 3;

// Number of days to download historic GFS data (last 14 days available in theory)
const GFS_CYCLE_MAX_D = process.env.MAX_HISTORY_DAYS || 2;

// Number of forecast hours to download for each model cycle
const GFS_FORECAST_MAX_H = process.env.MAX_FORECAST_HOURS || 18;


// cors config
const whitelist = [
  "http://localhost:8080",
  "http://localhost:3000",
  "http://localhost:4000",
  "http://localhost:5000",
];

const corsOptions = {
  origin(origin, callback) {
    const originIsWhitelisted = whitelist.indexOf(origin) !== -1;
    callback(null, originIsWhitelisted);
  },
};

app.use(compression());
app.listen(port, () => {
  console.log(`Running wind server for data resolution of ${resolution === "1" ? "1" : "0.5"} degree on port ${port}`);
});

app.get("/", cors(corsOptions), (req, res) => {
  res.send("Wind server : go to /latest for last wind data.");
});

app.get("/alive", cors(corsOptions), (req, res) => {
  res.send("Wind server is alive");
});

/**
 * Find and return the nearest available GFS forecast for the current timestamp.
 * Considers the 6 hour model update cycle and the 3 hour forecast steps.
 *
 * @param targetMoment {Object} UTC moment
 */
function findNearest(targetMoment, limitHours = GFS_FORECAST_MAX_H, searchBackwards = true) {
  console.log(`FindNearest: Target ${targetMoment.format("YYYYMMDD-HH")}`);
  const nearestGFSCycle = moment(targetMoment).hour(roundHours(moment(targetMoment).hour(), GFS_CYCLE_H));
  let forecastOffset = 0;

  if (nearestGFSCycle.diff(moment().utc(), "hours") > limitHours) {
    console.log("FindNearest: Requested timestamp too far in the future");
    return false;
  }

  do {
    forecastOffset = targetMoment.diff(nearestGFSCycle, "hours");
    const forecastOffsetRounded = roundHours(forecastOffset, GFS_FORECAST_H);
    const stamp = getStampFromMoment(nearestGFSCycle, forecastOffsetRounded);

    console.log(`FindNearest: Checking for ${stamp.filename}`);
    const file = `${__dirname}/json-data/${stamp.filename}.json`;
    if (checkPath(file, false)) {
      return file;
    }

    if (searchBackwards) {
      nearestGFSCycle.subtract(GFS_CYCLE_H, "hours");
    } else {
      nearestGFSCycle.add(GFS_CYCLE_H, "hours");
    }
  } while (forecastOffset < limitHours);

  return false;
}

app.get("/latest", cors(corsOptions), (req, res, next) => {
  const targetMoment = moment().utc();
  const filename = findNearest(targetMoment);
  if (!filename) {
    next(new Error("No current data available"));
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.sendFile(filename, {}, (err) => {
    if (err) {
      console.log(`Error sending ${filename}: ${err}`);
    }
  });
});

app.get("/nearest", cors(corsOptions), (req, res, next) => {
  const { time } = req.query;
  const limit = req.query.limit || GFS_FORECAST_MAX_H;

  if (!time || !moment(time).isValid()) {
    next(new Error("Invalid time, expecting ISO 8601 date"));
    return;
  }

  const targetMoment = moment.utc(time);
  const filename = findNearest(targetMoment, limit);
  if (!filename) {
    next(new Error("No current data available"));
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.sendFile(filename, {}, (err) => {
    if (err) {
      console.log(`Error sending ${filename}: ${err}`);
    }
  });
});

function nextFile(targetMoment, offset, success) {
  const previousTargetMoment = moment(targetMoment).subtract(GFS_CYCLE_H, "hours");

  if (moment.utc().diff(previousTargetMoment, "days") > GFS_CYCLE_MAX_D) {
    console.log("Harvest complete or there is a big gap in data");
    return;
  }
  if (!success || offset > GFS_FORECAST_MAX_H) {
    // Download previous targetMoment
    getGribData(previousTargetMoment, 0);
  } else {
    // Download forecast of current targetMoment
    getGribData(targetMoment, offset + GFS_FORECAST_H);
  }
}

function getStampFromMoment(targetMoment, offset) {
  const stamp = {};
  stamp.date = moment(targetMoment).format("YYYYMMDD");
  stamp.hour = roundHours(moment(targetMoment).hour(), GFS_CYCLE_H).toString().padStart(2, "0");
  stamp.forecast = offset.toString().padStart(GFS_FORECAST_H, "0");
  stamp.filename = `${moment(targetMoment).format("YYYY-MM-DD")}T${stamp.hour}.f${stamp.forecast}`;
  return stamp;
}

/**
 *
 * Finds and downloads the latest 6 hourly GRIB2 data from NOAA
 *
 */
function getGribData(targetMoment, offset) {
  const stamp = getStampFromMoment(targetMoment, offset);

  if (checkPath(`json-data/${stamp.filename}.json`, false)) {
    console.log(`Already got ${stamp.filename}, stopping harvest`);
    return;
  }

  const url = new URL(`${baseDir}`);
  const filesuffix = resolution === "1" ? `z.pgrb2.1p00.f${stamp.forecast}` : `z.pgrb2full.0p50.f${stamp.forecast}`;
  const file = `gfs.t${stamp.hour}${filesuffix}`;
  const params = {
    file,
    ...temp && {
      lev_surface: "on",
      var_TMP: "on",
    },
    ...wind && {
      lev_20_mb: "on",
      var_UGRD: "on",
      var_VGRD: "on",
    },
    leftlon: 0,
    rightlon: 360,
    toplat: 90,
    bottomlat: -90,
    dir: `/gfs.${stamp.date}/${stamp.hour}/atmos`,
  };
  Object.entries(params).forEach(([key, val]) => url.searchParams.append(key, val));

  fetch(url)
    .then((response) => {
      console.log(`RESP ${response.status} ${stamp.filename}`);

      if (response.status !== 200) {
        nextFile(targetMoment, offset, false);
        return;
      }

      if (!checkPath(`json-data/${stamp.filename}.json`, false)) {
        console.log("Write output");

        // Make sure output directory exists
        checkPath("grib-data", true);

        const f = fs.createWriteStream(`grib-data/${stamp.filename}`);
        response.body.pipe(f);
        f.on("finish", () => {
          f.close();
          convertGribToJson(stamp.filename, targetMoment, offset);
        });
      } else {
        console.log(`Already have ${stamp.filename}, not looking further`);
      }
    })
    .catch((err) => {
      console.log("ERR", stamp.filename, err);
      nextFile(targetMoment, offset, false);
    });
}

function convertGribToJson(filename, targetMoment, offset) {
  // Make sure output directory exists
  checkPath("json-data", true);

  exec(`${grib2json} --data --output json-data/${filename}.json --names --compact grib-data/${filename}`,
    { maxBuffer: 500 * 1024 },
    (error) => {
      if (error) {
        console.log(`Exec error: ${error}`);
        return;
      }
      console.log("Converted");

      // Delete raw grib data
      exec("rm grib-data/*");

      nextFile(targetMoment, offset, true);
    });
}

/**
 *
 * Round hours to expected interval
 *
 * @param hours
 * @param interval
 * @param floor
 * @returns {number}
 */
function roundHours(hours, interval, floor = true) {
  if (floor) {
    return Math.floor(hours / interval) * interval;
  }
  return Math.round(hours / interval) * interval;
}

/**
 * Sync check if path or file exists
 *
 * @param path {string}
 * @param mkdir {boolean} create dir if doesn't exist
 * @returns {boolean}
 */
function checkPath(path, mkdir) {
  try {
    fs.statSync(path);
    return true;
  } catch (e) {
    if (mkdir) {
      fs.mkdirSync(path);
    }
    return false;
  }
}

/**
 *
 * @param targetMoment {Object} moment to check for new data
 */
function run(targetMoment) {
  getGribData(targetMoment, 0);
}

// Check for new data every 15 mins
setInterval(() => {
  run(moment.utc());
}, 900000);

// Init harvest
run(moment.utc());
