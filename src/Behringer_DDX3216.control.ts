const VENDOR = "Behringer";
const EXTENSION_NAME = "DDX3216";
const VERSION = "0.7.0";
const AUTHOR = "Felix Gertz";

const MIDI_CHANNEL = 0; // 0 == channel 1.
const NUM_FADERS = 32;

const FADER_CC_BASE = 1; // CC 1..32 -> faders 1..32
const MUTE_CC_BASE = 33; // CC 33..64 -> mute buttons 1..32
const SELECT_CC_BASE = 65; // CC 65..96 -> select buttons 1..32 (used to open/close groups)
const PAN_CC_BASE = 97; // CC 97..128 -> pan knobs for channels 1..32

const FEEDBACK_INTERVAL_MS = 200;

loadAPI(24);
host.defineController(VENDOR, EXTENSION_NAME, VERSION, "57fb8818-a6a6-4a23-9413-2a1a5aea3ce1", AUTHOR);
host.setShouldFailOnDeprecatedUse(true);
host.defineMidiPorts(1, 1);
host.addDeviceNameBasedDiscoveryPair(["DDX3216"], ["DDX3216"]);

let midiIn: API.MidiIn;
let midiOut: API.MidiOut;
let trackBank: API.TrackBank;
let cursorTrack: API.CursorTrack;

// Takes and sends the sysex volume value from 0 to 1472
// ddx_dB = -80 + value/16
function sendSysExVolumeToMixer(faderIndex: number, sysExVolume: number) {
  const track = trackBank.getItemAt(faderIndex);
}

function displayedVolumeChanged(faderIndex: number, bitwigDisplayValue: string) {
  let dbVolume = parseFloat(bitwigDisplayValue);
  const isInf = bitwigDisplayValue.includes("Inf");

  if (!isInf && isNaN(dbVolume)) {
    return;
  }

  if (dbVolume < -80 || isInf) {
    dbVolume = -80;
  } else if (dbVolume > 12) {
    dbVolume = 12;
  }

  const sysExVolume = Math.round((dbVolume + 80) * 16);

  println(`Volume display: ${dbVolume} ${bitwigDisplayValue.includes("Inf")} sysex ${sysExVolume}`);

  sendSysExVolumeToMixer(faderIndex, sysExVolume);

  // host.scheduleTask(() => {
  //   const displayedValue = track.volume().displayedValue().get();
  
  //   println(`Volume value ${value} display: ${displayedValue}`);
  // }, 0);

  // const ddxMin = -74;
  // const ddxMax = 12;
  
  // // At 24bit
  // const bitwigMin = -132;
  // const bitwigMax = 6;

  // function mapBitwigDbToDdxDb(bitwigDb) {
  //   return ((bitwigDb - bitwigMin) / (bitwigMax - bitwigMin)) * (ddxMax - ddxMin) + ddxMin;
  // }
  
  // // Map DDX dB -> MIDI CC 0..127
  // function ddxDbToCc(ddxDb) {
  //   const cc = Math.round(((ddxDb - ddxMin) / (ddxMax - ddxMin)) * 127);
  //   return Math.max(0, Math.min(127, cc));
  // }

  // try {
  //   const vol = track.volume().get();
  //   // const volDb = track.volume().displayedValue().get();
  //   // const volDb = vol * (bitwigMax - bitwigMin) + bitwigMin;
  //   // const ddxDb = mapBitwigDbToDdxDb(volDb);
  //   // const ccVal = ddxDbToCc(volDb);
  //   const ccVal = Math.max(0, Math.min(127, Math.round((vol || 0) * 127)));

  //   host.println(` Volume ${vol} ${ccVal}`) //  ${volDb}

  //   midiOut.sendMidi(0xB0 | MIDI_CHANNEL, FADER_CC_BASE + faderIndex, ccVal);
  // } catch (e) {
  //   host.errorln(`volume error: ${e}`);
  // }
}

function init() {
  midiIn = host.getMidiInPort(0);
  midiOut = host.getMidiOutPort(0);

  // Create a track bank representing the visible area of the mixer
  trackBank = host.createMainTrackBank(NUM_FADERS, 0, 0);
  // Keep a cursor for global navigation/selection actions
  cursorTrack = host.createCursorTrack(0, 0);

  for (let i = 0; i < NUM_FADERS; i++) {
    const t = trackBank.getItemAt(i);
    t.volume().markInterested();
    t.pan().markInterested();
    t.mute().markInterested();

    t.volume().displayedValue().addValueObserver((displayedValue) => {
      displayedVolumeChanged(i, displayedValue);
      // sendVolumeChangeToMixer(i, value);
    });

    // t.volume().value().addRawValueObserver((value) => {
    //   // sendVolumeChangeToMixer(i, value);
    // });
  }
  
  println(`${VENDOR} ${EXTENSION_NAME} controller script version ${VERSION} written by ${AUTHOR} initialized. This script comes under GPLv3 license.`);
}
