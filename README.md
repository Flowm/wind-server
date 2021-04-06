# Wind Server

Simple REST web service to expose [GRIB2](http://en.wikipedia.org/wiki/GRIB) GFS wind forecast data (0.5 or 1 degree resolution, 6 hourly from [NOAA](http://nomads.ncep.noaa.gov/)) as pre-formatted JSON.
It is usually consumed by [leaflet-velocity](https://github.com/danwild/leaflet-velocity) or [wind-layer](https://github.com/sakitam-fdd/wind-layer).

It relies on the [grib2json](https://github.com/claustres/grib2json) CLI for data conversion. The 0.8 version of the converter is embedded in the project, if you want to use your own simply define the GRIB2JSON environment variable pointing to your grib2json command in the execution context.

Adapted from the [wind-server](https://github.com/weacast/wind-server) fork of [wind-js-server](https://github.com/danwild/wind-js-server).

## Build and Run

### Docker
``` bash
# Build docker image
$ docker build -t wind-server .

# Run container
$ docker run --name windserver -d -p 7000:7000 wind-server
```

### Node
``` bash
# Install dependencies
$ npm install

# Start
$ npm start
```

### Launch options

The following environment variables can be used to customize behaviour:

| Variable   | Description                             | Default               | Options     |
|------------|-----------------------------------------|-----------------------|-------------|
| PORT       | The port the server will listen on      | 7000                  | Port number |
| RESOLUTION | Requested GFS data resolution           | 0.5                   | 0.5, 1      |
| WIND       | Enable the download of wind data        | true                  | true, false |
| TEMP       | Enable the download of temperature data | false                 | true, false |
| DATA       | Set Wind Data Type                      | lev_10_m_above_ground | data type   |

## Endpoints

- **/latest** returns the most up to date JSON data available
- **/nearest** returns JSON data nearest to requested
    - $GET params:
        - `timeIso` an ISO timestamp for temporal target
        - `searchLimit` number of days to search beyond the timeIso (will search backwards, then forwards)
- **/alive** health check url, returns simple message

## License

MIT License (MIT)
