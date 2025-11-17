/**
 * Bitwig controller script for the Behringer DDX3216.
 * https://github.com/aldipower/bitwig-ddx3216-controlle
 *
 * Author(s): Felix Gertz
 * License: GPL 3.0
 *
 * If you like the controller script, please purchase my music album on
 * https://aldipower.bandcamp.com/album/das-reihenhaus
 */

const VENDOR = "Behringer";
const EXTENSION_NAME = "DDX3216";
const VERSION = "0.7.0";
const AUTHOR = "Felix Gertz";

const DEVICE_ID = 0x7f;
const NUM_FADERS = 16 * 3;
const NUM_EFFECT_FADERS = 8; // 8 on page 4 AUX/FX
const MASTER_FADER_INDEX_L = 64;

const FEEDBACK_INTERVAL_MS = 300;

const lastFaderReceiveAction: Record<number, number> = {};
const lastSendReceiveAction: Record<number, number> = {};
const lastPanReceiveAction: Record<number, number> = {};
const lastDeviceReceiveAction: Record<string, number> = {};

let midiIn: API.MidiIn;
let midiOut: API.MidiOut;
let trackBank: API.TrackBank;
let effectTrackBank: API.TrackBank;
let masterTrack: API.MasterTrack;

let midiChannelSetting: API.SettableRangedValue;
let faderValueMappingSetting: API.SettableEnumValue;

/* Device setup */

enum BitwigDeviceIds {
  "EQ-2" = "01af068e-1e49-4777-a6e6-7f1dc679227a",
  Gate = "556300ac-3a6e-4423-966a-5d5dde459a1b",
  Compressor = "2b1b4787-8d74-4138-877b-9197209eef0f",
  "EQ-5" = "227e2e3c-75d5-46f3-960d-8fb5529fe29f",
  "Delay-1" = "2a7a7328-3f7a-4afb-95eb-5230c298bb90",
};

const DDXDeviceNames: Record<BitwigDeviceIds, string> = {
  [BitwigDeviceIds["EQ-2"]]: "DDX HIGH PASS",
  [BitwigDeviceIds["Gate"]]: "DDX GATE",
  [BitwigDeviceIds["Compressor"]]: "DDX COMPRESSOR",
  [BitwigDeviceIds["EQ-5"]]: "DDX EQ",
  [BitwigDeviceIds["Delay-1"]]: "DDX DELAY",
};

const deviceList: Record<
  number,
  Record<
    number,
    | {
        deviceId: BitwigDeviceIds;
        device: API.Device;
        params: Record<string, API.Parameter>;
      }
    | undefined
  >
> = {};

function setDevice(
  faderIndex: number,
  deviceIndex: number,
  deviceId?: BitwigDeviceIds,
  device?: API.Device,
  params?: Record<string, API.Parameter>,
) {
  // println(`setDevice at ${faderIndex} ${deviceIndex} deviceId ${deviceId}`)

  if (deviceList[faderIndex] == null) {
    deviceList[faderIndex] = {};
  }

  if (deviceId == null) {
    deviceList[faderIndex][deviceIndex] = undefined;
    return;
  }

  deviceList[faderIndex][deviceIndex] = {
    deviceId,
    device,
    params,
  };
}

function getFirstDeviceById(faderIndex: number, deviceId: BitwigDeviceIds) {
  return Object.values(deviceList[faderIndex] || {}).find((entry) => entry?.deviceId === deviceId) || {
    device: undefined,
    deviceId: undefined,
    params: undefined,
  };
}

function isDevice(name: string, deviceId: BitwigDeviceIds) {
  return name.toUpperCase().startsWith(DDXDeviceNames[deviceId]);
}

// This is reverse to Bitwig - Highest band on the DDX is index 0
const ddxEq5FnCodeMap = {
  freq: ["22", "1E", "1A", "", "16"],
  gain: ["23", "1F", "1B", "", "17"],
  q: ["24", "20", "1C", "", "18"],
  type: ["21", "", "", "", "15"],
};

const eq5ParamsTemplate: Record<string, API.Parameter> = {
  GAIN1: null,
  FREQ1: null,
  Q1: null,
  TYPE1: null,
  ENABLE1: null,
  TYPE2: null,
  FREQ2: null,
  GAIN2: null,
  Q2: null,
  TYPE3: null,
  FREQ3: null,
  GAIN3: null,
  Q3: null,
  TYPE4: null,
  TYPE5: null,
  FREQ4: null,
  GAIN4: null,
  Q4: null,
  FREQ5: null,
  GAIN5: null,
  Q5: null,
  ENABLE2: null,
  ENABLE3: null,
  ENABLE4: null,
  ENABLE5: null,
};

const ddxEq2FnCodeMap = {
  freq: ["26", ""],
};

const eq2ParamsTemplate: Record<string, API.Parameter> = {
  LO_GAIN: null,
  LO_FREQ: null,
  LO_Q: null,
  TYPE1: null,
};

const ddxGateCodeMap = {
  ATTACK: "34",
  RELEASE: "35",
  DEPTH: "36", // DDX Range
  THRESHOLD_LEVEL: "37",
};

const gateParamsTemplate: Record<string, API.Parameter> = {
  ATTACK: null,
  RELEASE: null,
  DEPTH: null,
  THRESHOLD_LEVEL: null,
};

function getParamKeyByFnCode(map: any, fnCode: string) {
  for (const [key,value] of Object.entries(map)) {
    if (value === fnCode) {
      return key;
    }
  }
  return null;
}

/* Helper */

function getMidiChannel(): number | undefined {
  const midiChannel = midiChannelSetting.getRaw() - 1;
  return midiChannel === -1 ? undefined : midiChannel;
}

function getDeviceByte(midiChannel?: number) {
  if (midiChannel === undefined) {
    return 0x60;
  }
  return 0x40 | (midiChannel & 0x0f);
}

function constructSysEx(command: string) {
  return `F0002032${getDeviceByte(getMidiChannel())
    .toString(16)
    .padStart(2, "0")}0B${command}F7`;
}

function getTrack(faderIndex: number): API.Track | API.MasterTrack {
  return faderIndex === MASTER_FADER_INDEX_L ||
    faderIndex === MASTER_FADER_INDEX_L + 1
    ? masterTrack
    : faderIndex >= NUM_FADERS - 1 && faderIndex < NUM_FADERS - 1 + 16
    ? effectTrackBank.getItemAt(faderIndex - NUM_FADERS)
    : trackBank.getItemAt(faderIndex);
}

/* To DDX3216 */

// Takes and sends the sysex volume value from 0 to 1472
// ddx_dB = -80 + value/16
function sendSysExVolumeToMixer(faderIndex: number, sysExVolume: number) {
  const lastActionTimestamp = lastFaderReceiveAction[faderIndex];

  if (
    lastActionTimestamp != null &&
    Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp
  ) {
    return;
  }

  const high7bit = ((sysExVolume >> 7) & 0x7f).toString(16).padStart(2, "0");
  const low7bit = (sysExVolume & 0x7f).toString(16).padStart(2, "0");

  // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX VOLUME_FUNCTION_CODE VALUE
  const command = `2001${faderIndex
    .toString(16)
    .padStart(2, "0")}01${high7bit}${low7bit}`.toUpperCase();

  const sysex = constructSysEx(command);

  midiOut.sendSysex(sysex);
}

// The displayed volume does reflect a dB value,
// so we can apply a proper dB mapping to the hardware faders.
function displayedVolumeChanged(
  faderIndex: number,
  bitwigDisplayValue: string
) {
  if (faderValueMappingSetting.get() !== "exact") {
    return;
  }

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

  sendSysExVolumeToMixer(faderIndex, sysExVolume);
}

// Bitwig's normalized volume is simply the floating range from 0 to 1
// and does not really reflect a dB value, but the faders physical position.
function normalizedVolumeChanged(faderIndex: number, normalizedValue: number) {
  if (faderValueMappingSetting.get() !== "full range") {
    return;
  }

  const track = getTrack(faderIndex);
  normalizedValue = track.volume().get();

  sendSysExVolumeToMixer(faderIndex, 1472 * normalizedValue);
}

function sendSysExSendToMixer(
  faderIndex: number,
  sendIndex: number,
  sysExVolume: number
) {
  const lastActionTimestamp =
    lastSendReceiveAction[`${faderIndex}${sendIndex}`];

  if (
    lastActionTimestamp != null &&
    Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp
  ) {
    return;
  }

  const sendFunctionCode = sendsFunctionCodes[sendIndex];

  if (sendFunctionCode == null) {
    return;
  }

  const high7bit = ((sysExVolume >> 7) & 0x7f).toString(16).padStart(2, "0");
  const low7bit = (sysExVolume & 0x7f).toString(16).padStart(2, "0");

  // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX SEND_FUNCTION_CODE VALUE
  const command = `2001${faderIndex
    .toString(16)
    .padStart(2, "0")}${sendFunctionCode}${high7bit}${low7bit}`.toUpperCase();

  const sysex = constructSysEx(command);

  midiOut.sendSysex(sysex);
}

function normalizedSendChanged(
  faderIndex: number,
  sendIndex: number,
  normalizedValue: number
) {
  sendSysExSendToMixer(faderIndex, sendIndex, 1472 * normalizedValue);
}

function sendModeChanged(
  faderIndex: number,
  sendIndex: number,
  sendMode: string
) {
  const sendModeFunctionCode = sendsPostPreFunctionCodes[sendIndex];

  if (sendModeFunctionCode == null) {
    return;
  }

  const mode = sendMode === "PRE" ? "0001" : "0000";

  // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX SEND_FUNCTION_CODE VALUE
  const command = `2001${faderIndex
    .toString(16)
    .padStart(2, "0")}${sendModeFunctionCode}${mode}`.toUpperCase();

  const sysex = constructSysEx(command);

  midiOut.sendSysex(sysex);
}

function sendSysExMuteToMixer(faderIndex: number, isMuted: boolean) {
  const data = isMuted ? "0001" : "0000";

  // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX MUTE_FUNCTION_CODE VALUE
  const command = `2001${faderIndex
    .toString(16)
    .padStart(2, "0")}02${data}`.toUpperCase();

  const sysex = constructSysEx(command);

  midiOut.sendSysex(sysex);
}

function panChanged(faderIndex: number, value: number) {
  const lastActionTimestamp = lastPanReceiveAction[faderIndex];

  if (
    lastActionTimestamp != null &&
    Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp
  ) {
    return;
  }

  const sysexValue = 30 + Math.round(value * 30);

  const high7bit = ((sysexValue >> 7) & 0x7f).toString(16).padStart(2, "0");
  const low7bit = (sysexValue & 0x7f).toString(16).padStart(2, "0");

  // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX MUTE_FUNCTION_CODE VALUE
  const command = `2001${faderIndex
    .toString(16)
    .padStart(2, "0")}03${high7bit}${low7bit}`.toUpperCase();

  const sysex = constructSysEx(command);
  midiOut.sendSysex(sysex);
}

function toggleGroupStatus(faderIndex: number, isGroupExpanded: boolean) {
  const trackCount = trackBank.itemCount().get() - 1;

  if (trackCount <= 0) {
    return;
  }

  if (!isGroupExpanded) {
    let rightPadding = Math.max(8, 16 - (trackCount % 16));
    if (rightPadding === 16) {
      rightPadding = 8;
    }

    for (
      let i = faderIndex + 1;
      i < Math.min(NUM_FADERS, trackCount + rightPadding);
      i++
    ) {
      resetFader(i);
    }
  }
}

function resetFader(faderIndex: number) {
  displayedVolumeChanged(faderIndex, "-80");
  panChanged(faderIndex, 0);
  sendSysExMuteToMixer(faderIndex, false);
}

function sendSysExDeviceToMixer(faderIndex: number, fnCode: string, sysExValue: number) {
  if (!fnCode) {
    return;
  }

  const lastActionTimestamp = lastDeviceReceiveAction[`${faderIndex}${fnCode}`];

  if (
    lastActionTimestamp != null &&
    Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp
  ) {
    return;
  }

  const high7bit = ((sysExValue >> 7) & 0x7f).toString(16).padStart(2, "0");
  const low7bit = (sysExValue & 0x7f).toString(16).padStart(2, "0");

  // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX FUNCTION_CODE VALUE
  const command = `2001${faderIndex
    .toString(16)
    .padStart(2, "0")}${fnCode}${high7bit}${low7bit}`.toUpperCase();

  const sysex = constructSysEx(command);

  midiOut.sendSysex(sysex);
}

//// from EQ-2

function sendHighPassParamToDDX(faderIndex: number, eqParamKey: string, displayedValue: string, value: number) {
  const bandIndex = eqParamKey === "LO_FREQ" ? 0 : -1;

  if (isNaN(bandIndex) || bandIndex < 0 || bandIndex > 1) {
    return;
  }

  let freq = displayedValue ? parseFloat(displayedValue) : 0;
  freq *= displayedValue.includes("kHz") ? 1000 : 1;

  if (!freq || isNaN(freq)) {
    return;
  }

  if (freq > 400) {
    freq = 400;
  } else if (freq < 4) {
    freq = 4;
  }

  const sysExFreq = Math.round(80 * Math.log(freq / 4) / Math.log(100));
  
  sendSysExDeviceToMixer(faderIndex, ddxEq2FnCodeMap.freq[bandIndex], sysExFreq);
}

//// from EQ-5

function sendEQ5ParamToDDX(faderIndex: number, eqParamKey: string, displayedValue: string, value: number) {
  const bandIndex = Number(eqParamKey.slice(-1))-1;

  if (isNaN(bandIndex) || bandIndex < 0 || bandIndex > 4) {
    return;
  }

  // Skip fourth band
  if (bandIndex === 3) {
    return;
  }

  if (eqParamKey.startsWith("FREQ")) {
    let freq = displayedValue ? parseFloat(displayedValue) : 0;
    freq *= displayedValue.includes("kHz") ? 1000 : 1;

    if (!freq || isNaN(freq)) {
      return;
    }

    if (freq > 20000) {
      freq = 20000;
    } else if (freq < 20) {
      freq = 20;
    }

    const sysExFreq = Math.round(159 * (Math.log(freq / 20) / Math.log(1000)));
    
    sendSysExDeviceToMixer(faderIndex, ddxEq5FnCodeMap.freq[bandIndex], sysExFreq);
  }

  else if (eqParamKey.startsWith("Q")) {
    let qValue = displayedValue ? parseFloat(displayedValue) : 0;
    const isInf = displayedValue.includes("Inf");
  
    if (!isInf && isNaN(qValue)) {
      return;
    }

    if (qValue > 10) {
      qValue = 10;
    } else if (qValue < 0.1) {
      qValue = 0.1;
    }

    const sysExQ = Math.round(20 * Math.log10​(qValue/0.1));

    sendSysExDeviceToMixer(faderIndex, ddxEq5FnCodeMap.q[bandIndex], sysExQ);
  }

  else if (eqParamKey.startsWith("TYPE") && (bandIndex === 0 || bandIndex === 4)) {
    let filterType = 0; // DDX: Param
  
    if (value < 0.4 && value >= 0) {
      filterType = 1; // DDX: LC
    } else if (value === 1) {
      filterType = 2; // DDX: LSh
    }

    sendSysExDeviceToMixer(faderIndex, ddxEq5FnCodeMap.type[bandIndex], filterType);
  }

  else if (eqParamKey.startsWith("GAIN")) {
    let dbVolume = displayedValue ? parseFloat(displayedValue) : 0;
    const isInf = displayedValue.includes("Inf");
  
    if (!isInf && isNaN(dbVolume)) {
      return;
    }
  
    if (dbVolume < -18 || isInf) {
      dbVolume = -18;
    } else if (dbVolume > 18) {
      dbVolume = 18;
    }
  
    const sysExVolume = Math.round((dbVolume + 18) * 2);

    sendSysExDeviceToMixer(faderIndex, ddxEq5FnCodeMap.gain[bandIndex], sysExVolume);
  }
}

function sendGateParamToDDX(faderIndex: number, gateParamKey: string, displayedValue: string, value: number) {
  const fnCode = ddxGateCodeMap[gateParamKey];

  if (fnCode == null) {
    return;
  }

  // ATTACK 0.10 ms 0
  // ATTACK 0.91 ms 0.31999999999999984
  // ATTACK 3.16 ms 0.5
  // ATTACK 100 ms 1
  // DDX 0ms - 200ms

  // RELEASE 1.00 ms 0
  // RELEASE 5.82 ms 0.2550000000000005
  // RELEASE 31.6 ms 0.49999999999999933
  // RELEASE 1.00 s 1
  // DDX 20ms - 5s

  // DEPTH 0 dB 0
  // DEPTH +60 dB 0.5
  // DEPTH +120 dB 1
  // DDX 0db - -60db - Inf

  // -Inf , -144db, 0db
  // THRESHOLD_LEVEL -10.0 dB 0.6800000000000005
  // THRESHOLD_LEVEL -40.1 dB 0.21500000000000008
  // DDX -90dB - 0dB


  // -Inf dB 0
  // -144 dB 0.004
  // -120 dB 0.01000000000000001
  // -60.0 dB 0.1000000000000001
  // -20.0 dB 0.464400000000001
  // -10.0 dB 0.6820000000000026
  // -6.0 dB 0.7940000000000018
  // 0 dB 1

  if (gateParamKey === "ATTACK") {
    let ms = displayedValue ? parseFloat(displayedValue) : 0;

    if (!displayedValue.includes("ms") && displayedValue.includes("s")) {
      ms *= 1000;
    }

    if (ms < 0) {
      ms = 0;
    } else if (ms > 200) {
      ms = 200;
    }

    const sysExValue = Math.round(ms);

    sendSysExDeviceToMixer(faderIndex, fnCode, sysExValue);
  } else if (gateParamKey === "RELEASE") {
    let ms = displayedValue ? parseFloat(displayedValue) : 0;

    if (!displayedValue.includes("ms") && displayedValue.includes("s")) {
      ms *= 1000;
    }

    if (ms < 20) {
      ms = 20;
    } else if (ms > 5000) {
      ms = 5000;
    }

    const sysExValue = Math.round(255 * (Math.log(ms / 20) / Math.log(250)));

    sendSysExDeviceToMixer(faderIndex, fnCode, sysExValue);
  } else if (gateParamKey === "DEPTH") {
    let dbDepth = displayedValue ? parseFloat(displayedValue) : 0;
    const isInf = displayedValue.includes("Inf");

    if (dbDepth < 0) {
      dbDepth = 0;
    } else if (dbDepth > 61 || isInf) {
      dbDepth = 61;
    }

    const sysExVolume = Math.round(dbDepth);

    sendSysExDeviceToMixer(faderIndex, fnCode, sysExVolume);
  } else if (gateParamKey === "THRESHOLD_LEVEL") {
    println(`${displayedValue} ${value}`)

    let dbThreshold = displayedValue ? parseFloat(displayedValue) : 0;
    let isInf = displayedValue.includes("Inf");

    if (dbThreshold < -90 || isInf) {
      dbThreshold = -90;
    } else if (dbThreshold > 0) {
      dbThreshold = 0;
    }
  
    const sysExVolume = Math.round(dbThreshold + 90);

    sendSysExDeviceToMixer(faderIndex, fnCode, sysExVolume);
  }
}

/* From DDX3216 */

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
  sysexVolume: number,
  settingsFaderValueMapping: string
) {
  try {
    const track = getTrack(faderIndex);

    let normalizedVolume: number;

    if (settingsFaderValueMapping === "exact") {
      const dbValue = sysexVolume / 16 - 80;
      normalizedVolume = dbToNormalized(dbValue);
    } else {
      normalizedVolume = sysexVolume / 1472;
    }

    track.volume().setImmediately(normalizedVolume);

    lastFaderReceiveAction[faderIndex] = Date.now();
  } catch (error) {
    host.errorln(`Could not set Bitwig fader volume by sysex ${error}`);
  }
}

function setBitwigSendVolume(
  faderIndex: number,
  sendIndex: number,
  sysexVolume: number
) {
  const track = getTrack(faderIndex);

  const normalizedVolume = sysexVolume / 1472;
  const sendItem = track.sendBank().getItemAt(sendIndex);

  if (sendItem) {
    // This enables the send - otherwise Bitwig stalls on them
    if (!sendItem.isEnabled().getAsBoolean()) {
      sendItem.isEnabled().set(true);
      sendItem.set(0);
    }
    sendItem.set(normalizedVolume);

    lastSendReceiveAction[`${faderIndex}${sendIndex}`] = Date.now();
  }
}

function setBitwigSendPrePost(
  faderIndex: number,
  sendIndex: number,
  isPost: boolean
) {
  const track = getTrack(faderIndex);
  const sendItem = track.sendBank().getItemAt(sendIndex);

  if (sendItem) {
    sendItem.sendMode().set(isPost ? "POST" : "PRE");
  }
}

function setBitwigTrackMute(faderIndex: number, isMuted: boolean) {
  const track = getTrack(faderIndex);
  track.mute().set(isMuted);
}

function setBitwigFaderPanBySysexValue(faderIndex: number, sysexPan: number) {
  try {
    const track = getTrack(faderIndex);

    if (
      faderIndex === MASTER_FADER_INDEX_L ||
      faderIndex === MASTER_FADER_INDEX_L + 1
    ) {
      sysexPan = 60 - sysexPan;
    }

    const panValue = -1 + sysexPan / 30;

    track.pan().setRaw(panValue);

    lastPanReceiveAction[faderIndex] = Date.now();
  } catch (error) {
    host.errorln(`Could not set Bitwig fader pan by sysex ${error}`);
  }
}

function selectBitwigFaderAndCloseOpenGroup(
  faderIndex: number,
  groupIsOpen: boolean
) {
  const track: API.Track = trackBank.getItemAt(faderIndex);
  track.selectInEditor();

  track.makeVisibleInArranger();
  track.makeVisibleInMixer();

  if (track.isGroup()) {
    track.isGroupExpanded().set(groupIsOpen);
  }
}

//// to EQ-2

function setBitwigHighPassIsEnabled(faderIndex: number, isEnabled: boolean) {
  const { device } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-2"]);

  if (device) {
    device.isEnabled().set(isEnabled);
    lastDeviceReceiveAction[`${faderIndex}25`] = Date.now();
  }
}

function setBitwigHighPassFreq(faderIndex: number, fnCode: string, sysexValue: number) {
  const bandIndex = ddxEq2FnCodeMap.freq.indexOf(fnCode);

  if (bandIndex < 0) {
    return;
  }

  const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-2"]);
  if (device) {
    let freq = 4 * Math.pow(100, sysexValue / 80);

    if (freq > 20000) {
      freq = 20000;
    } else if (freq < 20) {
      freq = 20;
    }

    const param = params[`LO_FREQ`];
    param.setImmediately(freqToNormalized(freq));

    const paramType = params[`TYPE1`];
    paramType.setImmediately(1/3);
    
    const paramQ = params[`LO_Q`];
    paramQ.setImmediately(qToNormalized(0.71));

    lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
  }
}

//// to EQ-5

function setBitwigEQIsEnabled(faderIndex: number, isEnabled: boolean) {
  const { device } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-5"]);

  if (device) {
    device.isEnabled().set(isEnabled);
    lastDeviceReceiveAction[`${faderIndex}14`] = Date.now();
  }
}

function freqToNormalized(freq: number): number {
  return (Math.log(freq) - Math.log(20)) / (Math.log(20000) - Math.log(20));
}

function setBitwigEQFreq(faderIndex: number, fnCode: string, sysexValue: number) {
  const bandIndex = ddxEq5FnCodeMap.freq.indexOf(fnCode);

  if (bandIndex < 0) {
    return;
  }

  const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-5"]);
  if (device) {
    let freq = 20 * Math.pow(1000, sysexValue / 159);

    if (freq > 20000) {
      freq = 20000;
    } else if (freq < 20) {
      freq = 20;
    }

    const param = params[`FREQ${bandIndex+1}`];
    param.setImmediately(freqToNormalized(freq))

    lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
  }
}

function setBitwigEQGain(faderIndex: number, fnCode: string, sysexValue: number) {
  const bandIndex = ddxEq5FnCodeMap.gain.indexOf(fnCode);

  if (bandIndex < 0) {
    return;
  }

  const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-5"]);
  if (device) {
    let volDb = sysexValue / 2 - 18;

    const param = params[`GAIN${bandIndex+1}`];
    param.setImmediately((volDb - -24) / (24 - -24));

    lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
  }
}

function qToNormalized(q: number): number {
  return (Math.log(q) - Math.log(0.1)) / (Math.log(39.81) - Math.log(0.1));
}

function setBitwigEQQ(faderIndex: number, fnCode: string, sysexValue: number) {
  const bandIndex = ddxEq5FnCodeMap.q.indexOf(fnCode);

  if (bandIndex < 0) {
    return;
  }

  const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-5"]);
  if (device) {
    const q = 0.1 * Math.pow(100, sysexValue /40);

    const param = params[`Q${bandIndex+1}`];
    param.setImmediately(qToNormalized(q));

    lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
  }
}

function setBitwigEQType(faderIndex: number, fnCode: string, sysexValue: number) {
  const bandIndex = ddxEq5FnCodeMap.type.indexOf(fnCode);

  if (bandIndex < 0) {
    return;
  }

  const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-5"]);
  if (device) {
    // Band
    let type = 2/3;
  
    // Cut (2-Pole)  || 4-Pole would be type = 1/3
    if (sysexValue === 1) {
      type = 0
    // Shelve
    } else if (sysexValue === 2) {
      type = 1;
    }

    const param = params[`TYPE${bandIndex+1}`];
    param.setImmediately(type);

    // Reset Q to be aligned with DDX display - Regression, but determinism is better
    if (type === 0) {
      const param = params[`Q${bandIndex+1}`];
      param.setImmediately(qToNormalized(0.71));
    }

    lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
  }
}

//// to Gate

function setBitwigGateIsEnabled(faderIndex: number, isEnabled: boolean) {
  const { device } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Gate);

  if (device) {
    device.isEnabled().set(isEnabled);
    lastDeviceReceiveAction[`${faderIndex}32`] = Date.now();
  }
}

function gateDbToNorm(dB: number) {
  return 0.996 * Math.pow(10, 0.01664 * dB);
}

function setBitwigGateThreshold(faderIndex: number, fnCode: string, sysexValue: number) {
  const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Gate);
  if (device) {
    let volDb = -90 + sysexValue;

    const param = params[`THRESHOLD_LEVEL`];
    param.setImmediately(gateDbToNorm(volDb));

    lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
  }
}

function setBitwigGateRange(faderIndex: number, fnCode: string, sysexValue: number) {
  const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Gate);
  if (device) {
    let range = sysexValue;

    if (range >= 61) {
      range = 120;
    }

    const normed = Math.min(Math.max(range / 120, 0), 1);

    const param = params[`DEPTH`];
    param.setImmediately(normed);

    lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
  }
}

/* General control functions */

// DDX: AUX1, AUX2, AUX3, AUX4, FX1, FX2, FX3, FX4
const sendsFunctionCodes = ["46", "48", "4A", "4C", "50", "52", "54", "56"];
const sendsPostPreFunctionCodes = [
  "47",
  "49",
  "4B",
  "4D",
  "51",
  "53",
  "55",
  "57",
];

function processIncomingSysex(sysexData: string) {
  const settingsMidiChannel = getMidiChannel();
  const settingsFaderValueMapping = faderValueMappingSetting.get();

  const regexp = /f0002032([0-F]{2})0b([0-F]{2})([0-F]{2})(.*)F7/gim;

  const [, midiChannel, functionType, msgCount, messagesString] =
    regexp.exec(sysexData);

  const messages = messagesString.match(/.{1,8}/g);

  if (
    settingsMidiChannel !== undefined &&
    parseInt(midiChannel, 16) !== settingsMidiChannel
  ) {
    // println(
    //   `Incoming midi channel ${
    //     parseInt(midiChannel, 16) + 1
    //   } does not match set channel ${settingsMidiChannel + 1}.`
    // );
    return;
  }

  println(
    `Midi Channel: ${midiChannel} fnType: ${functionType} msgCount: ${msgCount} messages: ${messages.join(
      "|"
    )}`
  );

  if (parseInt(msgCount, 16) !== messages.length) {
    host.errorln(`Message count does not match messages length`);
  }

  // Function: Parameter change
  if (functionType === "20") {
    if (messages == null) {
      host.errorln("messages is null");
      return;
    }

    messages.forEach((message, i) => {
      if (message == null) {
        host.errorln("message is null");
        return;
      }

      const paramRegex = /([0-F]{2})([0-F]{2})([0-F]{2})([0-F]{2})/gim;

      const [, faderIndex, functionCode, highWord, lowWord] =
        paramRegex.exec(message);

      let sysexValue = Number(
        (parseInt(highWord, 16) << 7) | parseInt(lowWord, 16)
      );

      println(
        `faderIndex: ${faderIndex} fnCode: ${functionCode} highWord: ${highWord} lowWord: ${lowWord} sysexValue: ${sysexValue}`
      );

      if (isNaN(sysexValue)) {
        return;
      }

      let faderIndexInt = parseInt(faderIndex, 16);

      const normalFader = NUM_FADERS + NUM_EFFECT_FADERS - 1;

      // Map the FX1-4 mutes to the channels 5-8 on the FX tracks
      if (functionCode === "02") {
        if (faderIndexInt === normalFader + 1) {
          faderIndexInt = normalFader + 1 - 4;
        } else if (faderIndexInt === normalFader + 3) {
          faderIndexInt = normalFader + 3 - 5;
        } else if (faderIndexInt === normalFader + 5) {
          faderIndexInt = normalFader + 5 - 6;
        } else if (faderIndexInt === normalFader + 7) {
          faderIndexInt = normalFader + 7 - 7;
        }
      }

      if (
        (faderIndexInt > normalFader && faderIndexInt < MASTER_FADER_INDEX_L) ||
        faderIndexInt > MASTER_FADER_INDEX_L + 1
      ) {
        return;
      }

      // Volume
      if (functionCode === "01") {
        setBitwigFaderVolumeBySysexValue(
          faderIndexInt,
          sysexValue,
          settingsFaderValueMapping
        );

        // Mute
      } else if (functionCode === "02") {
        setBitwigTrackMute(faderIndexInt, !!sysexValue);

        // Pan
      } else if (functionCode === "03") {
        setBitwigFaderPanBySysexValue(faderIndexInt, sysexValue);

        // Select track and close/open group
      } else if (functionCode === "04") {
        selectBitwigFaderAndCloseOpenGroup(faderIndexInt, !sysexValue);

        // Sends Aux1,2,3,4 Fx1,2,3,4
      } else if (sendsFunctionCodes.includes(functionCode.toUpperCase())) {
        setBitwigSendVolume(
          faderIndexInt,
          sendsFunctionCodes.indexOf(functionCode.toUpperCase()),
          sysexValue
        );
        // Toggle Aux1,2,3,4 PRE/POST
      } else if (
        sendsPostPreFunctionCodes.includes(functionCode.toUpperCase())
      ) {
        setBitwigSendPrePost(
          faderIndexInt,
          sendsPostPreFunctionCodes.indexOf(functionCode.toUpperCase()),
          !sysexValue
        );
        // EQ on/off, etc..
      } else if (functionCode === "14") {
        setBitwigEQIsEnabled(faderIndexInt, !!sysexValue);
      } else if (ddxEq5FnCodeMap.freq.includes(functionCode.toUpperCase())) {
        setBitwigEQFreq(faderIndexInt, functionCode.toUpperCase(), sysexValue)
      } else if (ddxEq5FnCodeMap.gain.includes(functionCode.toUpperCase())) {
        setBitwigEQGain(faderIndexInt, functionCode.toUpperCase(), sysexValue)
      } else if (ddxEq5FnCodeMap.q.includes(functionCode.toUpperCase())) {
        setBitwigEQQ(faderIndexInt, functionCode.toUpperCase(), sysexValue)
      } else if (ddxEq5FnCodeMap.type.includes(functionCode.toUpperCase())) {
        setBitwigEQType(faderIndexInt, functionCode.toUpperCase(), sysexValue)
        // High Pass on/off, etc..
      } else if (functionCode === "25") {
        setBitwigHighPassIsEnabled(faderIndexInt, !!sysexValue);
      } else if (ddxEq2FnCodeMap.freq.includes(functionCode.toUpperCase())) {
        setBitwigHighPassFreq(faderIndexInt, functionCode.toUpperCase(), sysexValue)
        // Gate on/off, etc..
      } else if (functionCode === "32") {
        setBitwigGateIsEnabled(faderIndexInt, !!sysexValue);
      } else if (getParamKeyByFnCode(ddxGateCodeMap, functionCode.toUpperCase()) === "THRESHOLD_LEVEL") {
        setBitwigGateThreshold(faderIndexInt, functionCode.toUpperCase(), sysexValue);
      } else if (getParamKeyByFnCode(ddxGateCodeMap, functionCode.toUpperCase()) === "DEPTH") {
        setBitwigGateRange(faderIndexInt, functionCode.toUpperCase(), sysexValue);
      }
    });
  }
}

function setupDeviceBank(
  faderIndex: number,
  track: API.Track | API.MasterTrack
) {
  const deviceBank = track.createDeviceBank(8);

  for (let j = 0; j < 8; j++) {
    const device = deviceBank.getItemAt(j);

    const params = { 
      [BitwigDeviceIds["EQ-2"]]: { ...eq2ParamsTemplate },
      [BitwigDeviceIds.Gate]: { ...gateParamsTemplate },
      [BitwigDeviceIds["EQ-5"]]: { ...eq5ParamsTemplate },
    };

    const bitwigDevices = {
      [BitwigDeviceIds["EQ-2"]]: device.createSpecificBitwigDevice(
        // @ts-expect-error
        java.util.UUID.fromString(BitwigDeviceIds["EQ-2"])
      ),
      [BitwigDeviceIds.Gate]: device.createSpecificBitwigDevice(
        // @ts-expect-error
        java.util.UUID.fromString(BitwigDeviceIds.Gate)
      ),
      [BitwigDeviceIds["EQ-5"]]: device.createSpecificBitwigDevice(
        // @ts-expect-error
        java.util.UUID.fromString(BitwigDeviceIds["EQ-5"])
      ),
    };
    
    device.name().markInterested();

    device.name().addValueObserver((name: string) => {
      // println(`${i}-${j} NAME ${name}`);

      if (isDevice(name, BitwigDeviceIds["EQ-5"])) {
        setDevice(faderIndex, j, BitwigDeviceIds["EQ-5"], device, params[BitwigDeviceIds["EQ-5"]]);

        host.scheduleTask(() => {
          sendSysExDeviceToMixer(
            faderIndex,
            "14",
            device.isEnabled().getAsBoolean() ? 1 : 0
          );

          Object.entries(params[BitwigDeviceIds["EQ-5"]]).forEach(([eqParamKey, eqParam]) => {
            sendEQ5ParamToDDX(
              faderIndex,
              eqParamKey,
              eqParam.displayedValue().get(),
              eqParam.value().get()
            );
          });
        }, 0);
      } else if (isDevice(name, BitwigDeviceIds.Gate)) {
        setDevice(faderIndex, j, BitwigDeviceIds.Gate, device, params[BitwigDeviceIds.Gate]);

        host.scheduleTask(() => {
          sendSysExDeviceToMixer(
            faderIndex,
            "32",
            device.isEnabled().getAsBoolean() ? 1 : 0
          );

          Object.entries(params[BitwigDeviceIds.Gate]).forEach(([paramKey, param]) => {
            sendGateParamToDDX(
              faderIndex,
              paramKey,
              param.displayedValue().get(),
              param.value().get()
            );
          });
        }, 0);
      } else if (isDevice(name, BitwigDeviceIds["EQ-2"])) {
        setDevice(faderIndex, j, BitwigDeviceIds["EQ-2"], device, params[BitwigDeviceIds["EQ-2"]]);

        host.scheduleTask(() => {
          sendSysExDeviceToMixer(
            faderIndex,
            "25",
            device.isEnabled().getAsBoolean() ? 1 : 0
          );

          Object.entries(params[BitwigDeviceIds["EQ-2"]]).forEach(([eqParamKey, eqParam]) => {
            sendHighPassParamToDDX(
              faderIndex,
              eqParamKey,
              eqParam.displayedValue().get(),
              eqParam.value().get()
            );
          });
        }, 0);
      } else {
        setDevice(faderIndex, j, undefined);
      }
    });

    Object.entries(params).forEach(([deviceId, specificParams]) => {
      Object.keys(specificParams).forEach((paramKey) => {
        const param = bitwigDevices[deviceId].createParameter(paramKey);
        param.name().markInterested();
        param.displayedValue().markInterested();
        param.value().markInterested();
  
        param.displayedValue().addValueObserver((value) => {
          if (isDevice(device.name().get(), BitwigDeviceIds["EQ-5"])) {
            // println(
            //   `DD ${faderIndex}-${j} ${paramKey} "${param.name().get()}" ${param
            //     .displayedValue()
            //     .get()} ${param.value().get()}`
            // );
            sendEQ5ParamToDDX(
              faderIndex,
              paramKey,
              param.displayedValue().get(),
              param.value().get()
            );
          } else if (isDevice(device.name().get(), BitwigDeviceIds.Gate)) {
            sendGateParamToDDX(
              faderIndex,
              paramKey,
              param.displayedValue().get(),
              param.value().get()
            );
          } else if (isDevice(device.name().get(), BitwigDeviceIds["EQ-2"])) {
            sendHighPassParamToDDX(
              faderIndex,
              paramKey,
              param.displayedValue().get(),
              param.value().get()
            );
        }
        });
  
        specificParams[paramKey] = param;
      });
    });

    device.isEnabled().markInterested();

    device.isEnabled().addValueObserver((isEnabled) => {
      if (isDevice(device.name().get(), BitwigDeviceIds["EQ-5"])) {
        sendSysExDeviceToMixer(faderIndex, "14", isEnabled ? 1 : 0);
      } else if (isDevice(device.name().get(), BitwigDeviceIds.Gate)) {
        sendSysExDeviceToMixer(faderIndex, "32", isEnabled ? 1 : 0);
      } else if (isDevice(device.name().get(), BitwigDeviceIds["EQ-2"])) {
        sendSysExDeviceToMixer(faderIndex, "25", isEnabled ? 1 : 0);
      }
    });

    // device.addDirectParameterIdObserver((ids) => {
    //   println(`faderIndex ${faderIndex} deviceIndex ${j} ids ${JSON.stringify(ids)}`);
    // });
    // device.addDirectParameterValueDisplayObserver(128, (id: string, value: string) => {
    //   println(`AA faderIndex ${faderIndex} deviceIndex ${j} id ${id} value ${value}`);
    // }).setObservedParameterIds(["CONTENTS/GAIN1"]);
  }

  // deviceBank.itemCount().addValueObserver((count: number) => {
  //   if (count) {
  //     // const device = deviceBank.getItemAt(0);
  //     // println(`${device.name().get()}`);
  //   }
  // }, 0);
}

function createBitwigSettingsUI() {
  midiChannelSetting = host
    .getPreferences()
    .getNumberSetting("MIDI channel (0 = omni)", "Connection", 0, 16, 1, "", 1);

  faderValueMappingSetting = host
    .getPreferences()
    .getEnumSetting("dB mapping", "Fader", ["exact", "full range"], "exact");

  host
    .getPreferences()
    .getStringSetting(
      "Developed by Felix Gertz",
      "Support",
      128,
      "Support me via https://aldipower.bandcamp.com/album/das-reihenhaus and purchase the album. Thank you so much."
    );
}

function registerObserver() {
  trackBank.itemCount().markInterested();

  // Normal tracks
  for (let i = 0; i < NUM_FADERS; i++) {
    const t = trackBank.getItemAt(i);
    t.volume().markInterested();
    t.pan().markInterested();
    t.mute().markInterested();
    t.isGroupExpanded().markInterested();

    t.isGroupExpanded().addValueObserver((isGroupExpanded) => {
      toggleGroupStatus(i, isGroupExpanded);
    });

    t.volume()
      .displayedValue()
      .addValueObserver((displayedValue) => {
        displayedVolumeChanged(i, displayedValue);
      });

    t.volume()
      .value()
      .addRawValueObserver((value) => {
        normalizedVolumeChanged(i, value);
      });

    // 33-48 won't see panning on the DDX
    t.pan()
      .value()
      .addRawValueObserver((value) => {
        panChanged(i, value);
      });

    t.mute().addValueObserver((isMuted) => {
      sendSysExMuteToMixer(i, isMuted);
    });

    setupDeviceBank(i, t);

    for (let j = 0; j < NUM_EFFECT_FADERS; j++) {
      const sendItem = t.sendBank().getItemAt(j);
      sendItem.isEnabled().markInterested();

      sendItem.value().addRawValueObserver((value) => {
        normalizedSendChanged(i, j, value);
      });

      sendItem.sendMode().addValueObserver((value) => {
        sendModeChanged(i, j, value);
      });
    }
  }

  // Effect tracks
  for (let i = 0; i < NUM_EFFECT_FADERS; i++) {
    const t = effectTrackBank.getItemAt(i);
    t.volume().markInterested();
    t.pan().markInterested();
    t.mute().markInterested();

    t.volume()
      .displayedValue()
      .addValueObserver((displayedValue) => {
        displayedVolumeChanged(NUM_FADERS + i, displayedValue);
      });

    t.volume()
      .value()
      .addRawValueObserver((value) => {
        normalizedVolumeChanged(NUM_FADERS + i, value);
      });

    t.pan()
      .value()
      .addRawValueObserver((value) => {
        panChanged(NUM_FADERS + i, value);
      });

    t.mute().addValueObserver((isMuted) => {
      sendSysExMuteToMixer(NUM_FADERS + i, isMuted);
    });
  }

  // Master track
  masterTrack.volume().markInterested();
  masterTrack
    .volume()
    .displayedValue()
    .addValueObserver((displayedValue) => {
      displayedVolumeChanged(MASTER_FADER_INDEX_L, displayedValue);
    });
  masterTrack
    .volume()
    .value()
    .addRawValueObserver((value) => {
      normalizedVolumeChanged(MASTER_FADER_INDEX_L, value);
    });
  masterTrack.pan().markInterested();
  masterTrack
    .pan()
    .value()
    .addRawValueObserver((value) => {
      panChanged(MASTER_FADER_INDEX_L, value);
    });

  setupDeviceBank(MASTER_FADER_INDEX_L, masterTrack);
}

/* Hooks and init */

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

function init() {
  createBitwigSettingsUI();

  midiIn = host.getMidiInPort(0);
  midiOut = host.getMidiOutPort(0);

  trackBank = host.createMainTrackBank(NUM_FADERS, NUM_EFFECT_FADERS, 0);
  effectTrackBank = host.createEffectTrackBank(
    NUM_EFFECT_FADERS,
    NUM_EFFECT_FADERS,
    0
  );
  masterTrack = host.createMasterTrack(0);

  registerObserver();

  midiIn.setSysexCallback((sysexData) => {
    println(
      `Sysex received ${sysexData} midiChannelSetting: ${midiChannelSetting.getRaw()}`
    );

    if (!sysexData.startsWith("f0002032")) {
      return;
    }

    processIncomingSysex(sysexData);
  });

  println(
    `${VENDOR} ${EXTENSION_NAME} controller script version ${VERSION} written by ${AUTHOR} initialized. This script comes under GPLv3 license.`
  );
}

function exit() {
  for (let i = 0; i < NUM_FADERS; i++) {
    resetFader(i);
  }
  for (let i = 0; i < NUM_EFFECT_FADERS; i++) {
    resetFader(NUM_FADERS + i);
  }
  displayedVolumeChanged(MASTER_FADER_INDEX_L, "-12");
}

function flush() {}
