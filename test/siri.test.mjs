import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSiriVm, vehicleKey } from '../tools/lib/siri.mjs';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0">
  <ServiceDelivery>
    <ResponseTimestamp>2026-08-28T14:23:40+01:00</ResponseTimestamp>
    <VehicleMonitoringDelivery>
      <VehicleActivity>
        <RecordedAtTime>2026-08-28T14:23:32+01:00</RecordedAtTime>
        <MonitoredVehicleJourney>
          <LineRef>99</LineRef>
          <DirectionRef>outbound</DirectionRef>
          <FramedVehicleJourneyRef>
            <DataFrameRef>2026-08-28</DataFrameRef>
            <DatedVehicleJourneyRef>1407</DatedVehicleJourneyRef>
          </FramedVehicleJourneyRef>
          <PublishedLineName>99</PublishedLineName>
          <OperatorRef>SCCO</OperatorRef>
          <OriginName>Eastbourne</OriginName>
          <DestinationName>Hastings &amp; St Leonards</DestinationName>
          <OriginAimedDepartureTime>2026-08-28T13:40:00+01:00</OriginAimedDepartureTime>
          <VehicleLocation>
            <Longitude>0.47190</Longitude>
            <Latitude>50.84090</Latitude>
          </VehicleLocation>
          <Bearing>78.0</Bearing>
          <VehicleRef>36027</VehicleRef>
        </MonitoredVehicleJourney>
      </VehicleActivity>
      <VehicleActivity>
        <RecordedAtTime>2026-08-28T14:23:10+01:00</RecordedAtTime>
        <MonitoredVehicleJourney>
          <PublishedLineName>99</PublishedLineName>
          <OperatorRef>OTHR</OperatorRef>
          <VehicleLocation><Longitude>0</Longitude><Latitude>0</Latitude></VehicleLocation>
          <VehicleRef>36027</VehicleRef>
        </MonitoredVehicleJourney>
      </VehicleActivity>
    </VehicleMonitoringDelivery>
  </ServiceDelivery>
</Siri>`;

test('reads a vehicle sighting out of SIRI-VM', () => {
  const { responseAt, records } = parseSiriVm(FIXTURE);
  assert.equal(responseAt, '2026-08-28T14:23:40+01:00');
  assert.equal(records.length, 1, 'the vehicle with no fix is dropped');

  const [r] = records;
  assert.equal(r.lon, 0.4719);
  assert.equal(r.lat, 50.8409);
  assert.equal(r.vehicleRef, '36027');
  assert.equal(r.operatorRef, 'SCCO');
  assert.equal(r.line, '99');
  assert.equal(r.journeyRef, '1407');
  assert.equal(r.bearing, 78);
  assert.equal(r.directionRef, 'outbound');
  assert.equal(r.destinationName, 'Hastings & St Leonards', 'entities are decoded');
});

test('times come from when the vehicle reported, not when BODS answered', () => {
  const { records } = parseSiriVm(FIXTURE);
  assert.equal(records[0].t, Math.round(Date.parse('2026-08-28T14:23:32+01:00') / 1000));
});

test('a namespace prefix on the tags is tolerated', () => {
  const prefixed = FIXTURE.replace(/<(\/?)(Longitude|Latitude|VehicleRef)/g, '<$1siri:$2');
  const { records } = parseSiriVm(prefixed);
  assert.equal(records.length, 1);
  assert.equal(records[0].vehicleRef, '36027');
});

test('an empty delivery is not an error', () => {
  const { records } = parseSiriVm('<Siri><ServiceDelivery></ServiceDelivery></Siri>');
  assert.deepEqual(records, []);
});

test('vehicle identity carries the operator, since fleet numbers repeat', () => {
  assert.equal(vehicleKey({ operatorRef: 'SCCO', vehicleRef: '1' }), 'SCCO:1');
  assert.notEqual(
    vehicleKey({ operatorRef: 'SCCO', vehicleRef: '1' }),
    vehicleKey({ operatorRef: 'OTHR', vehicleRef: '1' }),
  );
});
