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

let midiIn: API.MidiIn;
let midiOut: API.MidiOut;
let trackBank: API.TrackBank;
let effectTrackBank: API.TrackBank;
let masterTrack: API.MasterTrack;

let midiChannelSetting: API.SettableRangedValue;
let faderValueMappingSetting: API.SettableEnumValue;

/* Templates */

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
  // "OUTPUT_GAIN": null,
  // "GLOBAL_AMOUNT": null,
  // "GLOBAL_SHIFT": null,
  // "SPECTRUM_SELECTOR": null,
};

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

function getTrack(faderIndex: number) {
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

function sendSysExEQToMixer(faderIndex: number, bandCode: string, sysExValue: number) {
  if (!bandCode) {
    return;
  }

  // const lastActionTimestamp = lastFaderReceiveAction[faderIndex];

  // if (
  //   lastActionTimestamp != null &&
  //   Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp
  // ) {
  //   return;
  // }

  const high7bit = ((sysExValue >> 7) & 0x7f).toString(16).padStart(2, "0");
  const low7bit = (sysExValue & 0x7f).toString(16).padStart(2, "0");

  // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX FUNCTION_CODE VALUE
  const command = `2001${faderIndex
    .toString(16)
    .padStart(2, "0")}${bandCode}${high7bit}${low7bit}`.toUpperCase();

  const sysex = constructSysEx(command);

  println(`sysex ${sysex}`)

  midiOut.sendSysex(sysex);
}

function sendEQParamToDDX(faderIndex: number, eqParamKey: string, displayedValue: string, value: number) {
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

    // Reziprok: freq = 20 * Math.pow(1000, value / 159);

    const sysExFreq = Math.round(159 * (Math.log(freq / 20) / Math.log(1000)));

    // This is reverse to Bitwig - Highest band on the DDX is index 0
    const bandFreqFnCodes = ["22", "1E", "1A", "", "16"];

    println(`FREQ ${freq} ${sysExFreq} ${sysExFreq.toString(16)}`)

    sendSysExEQToMixer(faderIndex, bandFreqFnCodes[bandIndex], sysExFreq);
  }

  if (eqParamKey.startsWith("Q")) {
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

    // Reziprok: Q = 0.1 * pow (100, value /40)
    const sysExQ = Math.round(20 * Math.log10​(qValue/0.1));

    const bandQFnCodes = ["24", "20", "1C", "", "18"];

    sendSysExEQToMixer(faderIndex, bandQFnCodes[bandIndex], sysExQ);
  }

  if (eqParamKey.startsWith("TYPE") && (bandIndex === 0 || bandIndex === 4)) {
    let filterType = 0; // DDX: Param
  
    if (value < 0.4 && value >= 0) {
      filterType = 1; // DDX: LC
    } else if (value === 1) {
      filterType = 2; // DDX: LSh
    }

    const bandTypeFnCodes = ["21", "", "", "", "15"];
    sendSysExEQToMixer(faderIndex, bandTypeFnCodes[bandIndex], filterType);
  }

  if (eqParamKey.startsWith("GAIN")) {
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
  
    const bandGainFnCodes = ["23", "1F", "1B", "", "17"];

    sendSysExEQToMixer(faderIndex, bandGainFnCodes[bandIndex], sysExVolume);
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
      }
    });
  }
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

    const deviceBank = t.createDeviceBank(8);

    for (let j = 0; j < 8; j++) {
      const eq5Params = { ...eq5ParamsTemplate };

      const device = deviceBank.getItemAt(j);

      const bitwigDevice_EQ5 = device.createSpecificBitwigDevice(
        // @ts-expect-error
        java.util.UUID.fromString("227e2e3c-75d5-46f3-960d-8fb5529fe29f")
      );

      device.name().markInterested();

      device.name().addValueObserver((name: string) => {
        // println(`${i}-${j} NAME ${name}`);

        if (name.startsWith("DDX EQ-5")) {
          host.scheduleTask(() => {
            Object.entries(eq5Params).forEach(([eqParamKey, eqParam]) => {
              println(
                `BY NAME CHANGE ${i}-${j} ${eqParamKey} "${eqParam.name().get()}" ${eqParam.displayedValue().get()} ${eqParam.value().get()}`
              );
              sendEQParamToDDX(i, eqParamKey, eqParam.displayedValue().get(), eqParam.value().get());
            });
          }, 0);
        } else {
          // Object.entries(eq5Params).forEach(([eqParamKey, eqParam]) => {
          //   println(`IN NAME RESET ${eqParamKey} ${eqParam.value().get()} ${eqParam.displayedValue().get()}`);
          //   if (eqParam.value().get()) {
          //     sendEQParamToDDX(i, eqParamKey, "-0.0");
          //   }
          // });
        }
      });

      Object.keys(eq5Params).forEach((eqParamKey) => {
        const param = bitwigDevice_EQ5.createParameter(eqParamKey);
        param.name().markInterested();
        param.displayedValue().markInterested();
        param.value().markInterested();

        param.displayedValue().addValueObserver((value) => {
          if (device.name().get().startsWith("DDX EQ-5")) {
            println(
              `DD ${i}-${j} ${eqParamKey} "${param.name().get()}" ${param
                .displayedValue()
                .get()} ${param.value().get()}`
            );
            sendEQParamToDDX(i, eqParamKey, param.displayedValue().get(), param.value().get());
          } else {
            // println(`IN VALUE RESET ${eqParamKey} ${param.value().get()} ${param.displayedValue().get()}`);
            // if (param.value().get()) {
            //   sendEQParamToDDX(i, eqParamKey, "-0.0");
            // }
          }
        });

        eq5Params[eqParamKey] = param;
      });

      // device.addDirectParameterIdObserver((ids) => {
      //   println(`faderIndex ${i} deviceIndex ${j} ids ${JSON.stringify(ids)}`);
      // });
      // device.addDirectParameterValueDisplayObserver(128, (id: string, value: string) => {
      //   println(`AA faderIndex ${i} deviceIndex ${j} id ${id} value ${value}`);
      // }).setObservedParameterIds(["CONTENTS/GAIN1"]);
    }

    // deviceBank.itemCount().addValueObserver((count: number) => {
    //   if (count) {
    //     // const device = deviceBank.getItemAt(0);
    //     // println(`${device.name().get()}`);
    //   }
    // }, 0);

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
    // println(
    //   `Sysex received ${sysexData} midiChannelSetting: ${midiChannelSetting.getRaw()}`
    // );

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
