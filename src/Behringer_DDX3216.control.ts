const VENDOR = "Behringer";
const EXTENSION_NAME = "DDX3216";
const VERSION = "0.7.0";
const AUTHOR = "Felix Gertz";

const MIDI_CHANNEL = 0; // 0 == channel 1.
const DEVICE_ID = 0x7f;
const NUM_FADERS = 32;

const FADER_CC_BASE = 1; // CC 1..32 -> faders 1..32
const MUTE_CC_BASE = 33; // CC 33..64 -> mute buttons 1..32
const SELECT_CC_BASE = 65; // CC 65..96 -> select buttons 1..32 (used to open/close groups)
const PAN_CC_BASE = 97; // CC 97..128 -> pan knobs for channels 1..32

const FEEDBACK_INTERVAL_MS = 200;

function getDeviceByte(deviceId?: number) {
  if (deviceId === undefined) {
    return 0x60;
  }
  return 0x40 | (deviceId & 0x0f);
}

function constructSysEx(command: string) {
  return `F0002032${getDeviceByte(DEVICE_ID)}0B${command}F7`;
}

loadAPI(24);
host.defineController(
  VENDOR,
  EXTENSION_NAME,
  VERSION,
  "57fb8818-a6a6-4a23-9413-2a1a5aea3ce1",
  AUTHOR
);
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
  const high7bit = ((sysExVolume >> 7) & 0x7f).toString(16).padStart(2, "0");
  const low7bit = (sysExVolume & 0x7f).toString(16).padStart(2, "0");

  // PARAMCHANGE_FUNC COUNT CHANNEL/FADERINDEX FUNCTION_CODE VALUE
  const command = `2001${faderIndex
    .toString(16)
    .padStart(2, "0")}01${high7bit}${low7bit}`.toUpperCase();

  const sysex = constructSysEx(command);

  // println(`sysex cmd ${sysex}`)

  midiOut.sendSysex(sysex);
}

function displayedVolumeChanged(
  faderIndex: number,
  bitwigDisplayValue: string
) {
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

  // println(`Volume display: ${dbVolume} ${bitwigDisplayValue.includes("Inf")} sysex ${sysExVolume}`);

  sendSysExVolumeToMixer(faderIndex, sysExVolume);

  // midiOut.sendMidi(0xB0 | MIDI_CHANNEL, FADER_CC_BASE + faderIndex, ccVal);

  // host.scheduleTask(() => {
  //   const displayedValue = track.volume().displayedValue().get();

  //   println(`Volume value ${value} display: ${displayedValue}`);
  // }, 0);
}

function dbToNormalized(db) {
  if (db <= -80.0) {
    return 0;
  } 
  if (db >= 6.0) {
    return 1;
  } 

  return Math.pow(10, (db - 6) / 60);
}

function setBitwigFaderVolumeBySysexValue(
  faderIndex: number,
  sysexVolume: number
) {
  try {
    const track = trackBank.getItemAt(faderIndex);
  
    const dbValue = sysexVolume / 16 - 80;
    const normalizedVolume = dbToNormalized(dbValue);
  
    track.volume().setImmediately(normalizedVolume);
  } catch (error) {
    errorln(`Could not set Bitwig fader volume by sysex ${error}`);
  }
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

    // t.volume().displayedValue().addValueObserver((displayedValue) => {
    //   displayedVolumeChanged(i, displayedValue);
    // });

    // t.volume().value().addRawValueObserver((value) => {
    //   // sendVolumeChangeToMixer(i, value);
    // });
  }

  midiIn.setSysexCallback((sysexData) => {
    println(`Sysex received ${sysexData}`);

    if (!sysexData.startsWith("f0002032")) {
      return;
    }

    // PARAMCHANGE_FUNC COUNT  CHANNEL/FADERINDEX FUNCTION_CODE VALUE
    // const command = `2001${faderIndex
    //   .toString(16)
    //   .padStart(2, "0")}01${high7bit}${low7bit}`.toUpperCase();

    const regexp = /f0002032([0-F]{2})0b([0-F]{2})([0-F]{2})(.*)F7/gim;
    const [, midiChannel, functionType, msgCount, messagesString] =
      regexp.exec(sysexData);
    const messages = messagesString.match(/.{1,8}/g);

    // F0002032 ${getDeviceByte(DEVICE_ID)}0B ${command}F7
    // f0002032 00 0b 20 02 0001082e 0101083a f7

    // Sysex received f0002032000b20020001032101010268f7
    // Midi Channel: 00 fnType: 20 msgCount: 02 messages: 00010321|01010268

    // TODO: Check for MIDI channel

    println(
      `Midi Channel: ${midiChannel} fnType: ${functionType} msgCount: ${msgCount} messages: ${messages.join(
        "|"
      )}`
    );

    if (parseInt(msgCount, 16) !== messages.length) {
      errorln(`Message count does not match messages length`);
    }

    // Parameter change
    if (functionType === "20") {
      if (messages == null) {
        println("messages is null");
        return;
      }

      messages.forEach((message, i) => {
        if (message == null) {
          errorln("message is null")
          return;
        }

        const paramRegex = /([0-F]{2})([0-F]{2})([0-F]{2})([0-F]{2})/gim;

        const [, faderIndex, functionCode, highWord, lowWord] =
          paramRegex.exec(message);

        let sysexValue = Number(
          (parseInt(highWord, 16) << 7) | parseInt(lowWord, 16)
        );

        println(
          `faderIndex: ${faderIndex} fnType: ${functionCode} highWord: ${highWord} lowWord: ${lowWord} sysexValue: ${sysexValue}`
        );

        if (isNaN(sysexValue)) {
          return;
        }

        const faderIndexInt = parseInt(faderIndex, 16);

        // Volume
        if (functionCode === "01") {
          setBitwigFaderVolumeBySysexValue(faderIndexInt, sysexValue);
        }
      });
    }
  });

  println(
    `${VENDOR} ${EXTENSION_NAME} controller script version ${VERSION} written by ${AUTHOR} initialized. This script comes under GPLv3 license.`
  );
}

function exit() {
  for (let i = 0; i < NUM_FADERS; i++) {
    displayedVolumeChanged(i, "-80");
  }
}

function flush() {}
