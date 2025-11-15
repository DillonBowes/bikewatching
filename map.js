// Import Mapbox and D3 as ES modules
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Mapbox access token
mapboxgl.accessToken = 'pk.eyJ1IjoiZGJ1Y3NkIiwiYSI6ImNtaHdjcXJjbTA1bTgybXEyZ3lta3FhOXEifQ.qn4Ku5EwztQk4BPAaGLksw';

// ---------------- Helper functions ----------------
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}
// --- Optimized time-bucketed data structures ---
// Two arrays of length 1440 (minutes in a day). Each index holds an array of trips that
// started / ended at that minute. This lets us avoid filtering the entire trips array
// on every slider update.
const departuresByMinute = Array.from({ length: 1440 }, () => []);
const arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// Efficiently retrieve trips within +/- 60 minutes of `minute`. If minute === -1, return all trips.
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) return tripsByMinute.flat();

  const minMinute = (minute - 60 + 1440) % 1440;
  const maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    // Wraps around midnight
    return tripsByMinute.slice(minMinute).concat(tripsByMinute.slice(0, maxMinute)).flat();
  }
  return tripsByMinute.slice(minMinute, maxMinute).flat();
}

// Compute station traffic using the pre-bucketed departures/arrivals arrays.
// timeFilter is minutes-since-midnight or -1 for no filter.
function computeStationTraffic(stations, timeFilter = -1) {
  const depTrips = filterByMinute(departuresByMinute, timeFilter);
  const arrTrips = filterByMinute(arrivalsByMinute, timeFilter);

  const departures = d3.rollup(depTrips, v => v.length, d => d.start_station_id);
  const arrivals = d3.rollup(arrTrips, v => v.length, d => d.end_station_id);

  return stations.map(station => {
    const id = station.short_name;
    station.departures = departures.get(id) ?? 0;
    station.arrivals = arrivals.get(id) ?? 0;
    station.totalTraffic = station.departures + station.arrivals;
    return station;
  });
}

// ---------------- Map Initialization ----------------
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

map.on('load', async () => {
  // Boston bike lanes
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });
  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: { 'line-color': 'green', 'line-width': 3, 'line-opacity': 0.4 },
  });

  // Cambridge bike lanes
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });
  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: { 'line-color': 'green', 'line-width': 3, 'line-opacity': 0.4 },
  });

  // SVG overlay for circles
  const svg = d3.select(map.getCanvasContainer())
    .append('svg')
    .style('position', 'absolute')
    .style('top', 0)
    .style('left', 0)
    .style('width', '100%')
    .style('height', '100%')
    .style('pointer-events', 'none');

  let stations, trips, circles, radiusScale;

  try {
    // Load stations
    const jsonData = await d3.json('bluebikes-stations.json');
    stations = jsonData.data.stations;

    // Load trips, parse dates, and populate minute buckets for fast filtering
    trips = await d3.csv('https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv', d => {
      d.started_at = new Date(d.started_at);
      d.ended_at = new Date(d.ended_at);

      // populate minute buckets
      try {
        const sMin = minutesSinceMidnight(d.started_at);
        const eMin = minutesSinceMidnight(d.ended_at);
        departuresByMinute[sMin].push(d);
        arrivalsByMinute[eMin].push(d);
      } catch (err) {
        // ignore malformed dates
      }

      return d;
    });

    // Compute initial traffic (no time filter)
    stations = computeStationTraffic(stations);

    // Create radius scale
    radiusScale = d3.scaleSqrt()
      .domain([0, d3.max(stations, d => d.totalTraffic)])
      .range([0, 25]);

    // Color quantize scale: maps departure ratio [0..1] to discrete steps {0, 0.5, 1}
    const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

    // Draw circles (use join so we can update later efficiently)
    circles = svg.selectAll('circle')
      .data(stations, d => d.short_name)
      .join(
        enter => enter.append('circle')
          .attr('stroke', 'white')
          .attr('stroke-width', 1)
          .attr('opacity', 0.8)
          .attr('r', d => radiusScale(d.totalTraffic))
          .style('--departure-ratio', d => (d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5))
          .each(function (d) {
            // Add <title> for browser tooltips (append after attributes)
            d3.select(this)
              .append('title')
              .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
          }),
        update => update
          .attr('r', d => radiusScale(d.totalTraffic))
          .style('--departure-ratio', d => (d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5))
          .each(function (d) {
            // Update existing title text
            const t = d3.select(this).select('title');
            if (!t.empty()) t.text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
            else d3.select(this).append('title').text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
          }),
        exit => exit.remove()
      );

    // Update circle positions
    function updatePositions() {
      circles.attr('cx', d => map.project([+d.lon, +d.lat]).x)
             .attr('cy', d => map.project([+d.lon, +d.lat]).y);
    }
    updatePositions();
    map.on('move', updatePositions);
    map.on('zoom', updatePositions);
    map.on('resize', updatePositions);
    map.on('moveend', updatePositions);

    // ---------------- Slider ----------------
    const timeSlider = document.getElementById('time-slider');
    const selectedTime = document.getElementById('selected-time');
    const anyTimeLabel = document.getElementById('any-time');

    function updateScatterPlot(timeFilter) {
      // Recompute station counts using the efficient bucket lookup
      const filteredStations = computeStationTraffic(stations, timeFilter);

      // Adjust circle size range depending on whether we are filtered
      timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

      // Rebind data and update radii and titles
      circles = svg.selectAll('circle')
        .data(filteredStations, d => d.short_name)
        .join(
          enter => enter.append('circle')
            .attr('stroke', 'white')
            .attr('stroke-width', 1)
            .attr('opacity', 0.8)
            .attr('r', d => radiusScale(d.totalTraffic))
            .style('--departure-ratio', d => (d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5)),
          update => update
            .attr('r', d => radiusScale(d.totalTraffic))
            .style('--departure-ratio', d => (d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5)),
          exit => exit.remove()
        );

      circles.selectAll('title')
        .data(d => [d])
        .join('title')
        .text(d => `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);

      // Re-position after join
      updatePositions();
    }

    function updateTimeDisplay() {
      const timeFilter = Number(timeSlider.value);
      if (timeFilter === -1) {
        selectedTime.textContent = '';
        anyTimeLabel.style.display = 'block';
      } else {
        selectedTime.textContent = formatTime(timeFilter);
        anyTimeLabel.style.display = 'none';
      }
      updateScatterPlot(timeFilter);
    }

    timeSlider.addEventListener('input', updateTimeDisplay);
    updateTimeDisplay();

  } catch (err) {
    console.error('Error loading BlueBike data:', err);
  }
});
