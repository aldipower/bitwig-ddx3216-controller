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
const lastFaderReceiveAction = {};
const lastSendReceiveAction = {};
const lastPanReceiveAction = {};
const lastDeviceReceiveAction = {};
let midiIn;
let midiOut;
let trackBank;
let effectTrackBank;
let masterTrack;
let midiChannelSetting;
let faderValueMappingSetting;
/* Device setup */
var BitwigDeviceIds;
(function (BitwigDeviceIds) {
    BitwigDeviceIds["EQ-2"] = "01af068e-1e49-4777-a6e6-7f1dc679227a";
    BitwigDeviceIds["Gate"] = "556300ac-3a6e-4423-966a-5d5dde459a1b";
    BitwigDeviceIds["Compressor"] = "2b1b4787-8d74-4138-877b-9197209eef0f";
    BitwigDeviceIds["EQ-5"] = "227e2e3c-75d5-46f3-960d-8fb5529fe29f";
    BitwigDeviceIds["Delay-1"] = "2a7a7328-3f7a-4afb-95eb-5230c298bb90";
})(BitwigDeviceIds || (BitwigDeviceIds = {}));
;
const DDXDeviceNames = {
    [BitwigDeviceIds["EQ-2"]]: "DDX HIGH PASS",
    [BitwigDeviceIds["Gate"]]: "DDX GATE",
    [BitwigDeviceIds["Compressor"]]: "DDX COMPRESSOR",
    [BitwigDeviceIds["EQ-5"]]: "DDX EQ",
    [BitwigDeviceIds["Delay-1"]]: "DDX DELAY",
};
const deviceList = {};
function setDevice(faderIndex, deviceIndex, deviceId, device, params) {
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
function getFirstDeviceById(faderIndex, deviceId) {
    return Object.values(deviceList[faderIndex] || {}).find((entry) => (entry === null || entry === void 0 ? void 0 : entry.deviceId) === deviceId) || {
        device: undefined,
        deviceId: undefined,
        params: undefined,
    };
}
function isDevice(name, deviceId) {
    return name.toUpperCase().startsWith(DDXDeviceNames[deviceId]);
}
// This is reverse to Bitwig - Highest band on the DDX is index 0
const ddxEq5FnCodeMap = {
    freq: ["22", "1E", "1A", "", "16"],
    gain: ["23", "1F", "1B", "", "17"],
    q: ["24", "20", "1C", "", "18"],
    type: ["21", "", "", "", "15"],
};
const eq5ParamsTemplate = {
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
const eq2ParamsTemplate = {
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
const gateParamsTemplate = {
    ATTACK: null,
    RELEASE: null,
    DEPTH: null,
    THRESHOLD_LEVEL: null,
};
const ddxCompressorCodeMap = {
    ATTACK: "2A",
    RELEASE: "2B",
    RATIO: "2C",
    THRESHOLD: "2E",
    OUTPUT: "2F",
};
const compressorParamsTemplate = {
    ATTACK: null,
    RELEASE: null,
    RATIO: null,
    THRESHOLD: null,
    OUTPUT: null,
};
function getParamKeyByFnCode(map, fnCode) {
    for (const [key, value] of Object.entries(map)) {
        if (value === fnCode) {
            return key;
        }
    }
    return null;
}
const ddxDelayCodeMap = {
    PHASE: "3D",
    TIME: "3E",
    FEEDBACK: "3F",
    MIX: "40",
};
const delayParamsTemplate = {
    PHASE: null,
    TIME: null,
    FEEDBACK: null,
    MIX: null,
};
/* Helper */
function getMidiChannel() {
    const midiChannel = midiChannelSetting.getRaw() - 1;
    return midiChannel === -1 ? undefined : midiChannel;
}
function getDeviceByte(midiChannel) {
    if (midiChannel === undefined) {
        return 0x60;
    }
    return 0x40 | (midiChannel & 0x0f);
}
function constructSysEx(command) {
    return `F0002032${getDeviceByte(getMidiChannel())
        .toString(16)
        .padStart(2, "0")}0B${command}F7`;
}
function getTrack(faderIndex) {
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
function sendSysExVolumeToMixer(faderIndex, sysExVolume) {
    const lastActionTimestamp = lastFaderReceiveAction[faderIndex];
    if (lastActionTimestamp != null &&
        Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp) {
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
function displayedVolumeChanged(faderIndex, bitwigDisplayValue) {
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
    }
    else if (dbVolume > 12) {
        dbVolume = 12;
    }
    const sysExVolume = Math.round((dbVolume + 80) * 16);
    sendSysExVolumeToMixer(faderIndex, sysExVolume);
}
// Bitwig's normalized volume is simply the floating range from 0 to 1
// and does not really reflect a dB value, but the faders physical position.
function normalizedVolumeChanged(faderIndex, normalizedValue) {
    if (faderValueMappingSetting.get() !== "full range") {
        return;
    }
    const track = getTrack(faderIndex);
    normalizedValue = track.volume().get();
    sendSysExVolumeToMixer(faderIndex, 1472 * normalizedValue);
}
function sendSysExSendToMixer(faderIndex, sendIndex, sysExVolume) {
    const lastActionTimestamp = lastSendReceiveAction[`${faderIndex}${sendIndex}`];
    if (lastActionTimestamp != null &&
        Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp) {
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
function normalizedSendChanged(faderIndex, sendIndex, normalizedValue) {
    sendSysExSendToMixer(faderIndex, sendIndex, 1472 * normalizedValue);
}
function sendModeChanged(faderIndex, sendIndex, sendMode) {
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
function sendSysExMuteToMixer(faderIndex, isMuted) {
    const data = isMuted ? "0001" : "0000";
    // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX MUTE_FUNCTION_CODE VALUE
    const command = `2001${faderIndex
        .toString(16)
        .padStart(2, "0")}02${data}`.toUpperCase();
    const sysex = constructSysEx(command);
    midiOut.sendSysex(sysex);
}
function panChanged(faderIndex, value) {
    const lastActionTimestamp = lastPanReceiveAction[faderIndex];
    if (lastActionTimestamp != null &&
        Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp) {
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
function toggleGroupStatus(faderIndex, isGroupExpanded) {
    const trackCount = trackBank.itemCount().get() - 1;
    if (trackCount <= 0) {
        return;
    }
    if (!isGroupExpanded) {
        let rightPadding = Math.max(8, 16 - (trackCount % 16));
        if (rightPadding === 16) {
            rightPadding = 8;
        }
        for (let i = faderIndex + 1; i < Math.min(NUM_FADERS, trackCount + rightPadding); i++) {
            resetFader(i);
        }
    }
}
function resetFader(faderIndex) {
    displayedVolumeChanged(faderIndex, "-80");
    panChanged(faderIndex, 0);
    sendSysExMuteToMixer(faderIndex, false);
}
function sendSysExDeviceToMixer(faderIndex, fnCode, sysExValue) {
    if (!fnCode) {
        return;
    }
    const lastActionTimestamp = lastDeviceReceiveAction[`${faderIndex}${fnCode}`];
    if (lastActionTimestamp != null &&
        Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp) {
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
function sendHighPassParamToDDX(faderIndex, eqParamKey, displayedValue, value) {
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
    }
    else if (freq < 4) {
        freq = 4;
    }
    const sysExFreq = Math.round(80 * Math.log(freq / 4) / Math.log(100));
    sendSysExDeviceToMixer(faderIndex, ddxEq2FnCodeMap.freq[bandIndex], sysExFreq);
}
//// from EQ-5
function sendEQ5ParamToDDX(faderIndex, eqParamKey, displayedValue, value) {
    const bandIndex = Number(eqParamKey.slice(-1)) - 1;
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
        }
        else if (freq < 20) {
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
        }
        else if (qValue < 0.1) {
            qValue = 0.1;
        }
        const sysExQ = Math.round(20 * Math.log10(qValue / 0.1));
        sendSysExDeviceToMixer(faderIndex, ddxEq5FnCodeMap.q[bandIndex], sysExQ);
    }
    else if (eqParamKey.startsWith("TYPE") && (bandIndex === 0 || bandIndex === 4)) {
        let filterType = 0; // DDX: Param
        if (value < 0.4 && value >= 0) {
            filterType = 1; // DDX: LC
        }
        else if (value === 1) {
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
        }
        else if (dbVolume > 18) {
            dbVolume = 18;
        }
        const sysExVolume = Math.round((dbVolume + 18) * 2);
        sendSysExDeviceToMixer(faderIndex, ddxEq5FnCodeMap.gain[bandIndex], sysExVolume);
    }
}
/// from Gate
function sendGateParamToDDX(faderIndex, gateParamKey, displayedValue, value) {
    const fnCode = ddxGateCodeMap[gateParamKey];
    if (fnCode == null) {
        return;
    }
    if (gateParamKey === "ATTACK") {
        let ms = displayedValue ? parseFloat(displayedValue) : 0;
        if (!displayedValue.includes("ms") && displayedValue.includes("s")) {
            ms *= 1000;
        }
        if (ms < 0) {
            ms = 0;
        }
        else if (ms > 200) {
            ms = 200;
        }
        const sysExValue = Math.round(ms);
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExValue);
    }
    else if (gateParamKey === "RELEASE") {
        let ms = displayedValue ? parseFloat(displayedValue) : 0;
        if (!displayedValue.includes("ms") && displayedValue.includes("s")) {
            ms *= 1000;
        }
        if (ms < 20) {
            ms = 20;
        }
        else if (ms > 5000) {
            ms = 5000;
        }
        const sysExValue = Math.round(255 * (Math.log(ms / 20) / Math.log(250)));
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExValue);
    }
    else if (gateParamKey === "DEPTH") {
        let dbDepth = displayedValue ? parseFloat(displayedValue) : 0;
        const isInf = displayedValue.includes("Inf");
        if (dbDepth < 0) {
            dbDepth = 0;
        }
        else if (dbDepth > 61 || isInf) {
            dbDepth = 61;
        }
        const sysExVolume = Math.round(dbDepth);
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExVolume);
    }
    else if (gateParamKey === "THRESHOLD_LEVEL") {
        println(`${displayedValue} ${value}`);
        let dbThreshold = displayedValue ? parseFloat(displayedValue) : 0;
        let isInf = displayedValue.includes("Inf");
        if (dbThreshold < -90 || isInf) {
            dbThreshold = -90;
        }
        else if (dbThreshold > 0) {
            dbThreshold = 0;
        }
        const sysExVolume = Math.round(dbThreshold + 90);
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExVolume);
    }
}
/// from Compressor
const DDXtoBitwigRatioMap = {
    ["1.0"]: 0,
    ["1.2"]: 0.164,
    ["1.4"]: 0.284,
    ["1.6"]: 0.374,
    ["1.8"]: 0.445,
    ["2.0"]: 0.5,
    ["2.5"]: 0.6,
    ["3.0"]: 0.667,
    ["3.5"]: 0.714,
    ["4.0"]: 0.75,
    ["5.0"]: 0.8,
    ["6.0"]: 0.8333,
    ["8.0"]: 0.875,
    ["10.0"]: 0.9,
    ["20.0"]: 0.95,
    ["100.0"]: 1,
};
function nearestKeyIndex(value, arr) {
    let low = 0;
    let high = arr.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const value = arr[mid];
        if (value === value)
            return mid;
        if (value < value)
            low = mid + 1;
        else
            high = mid - 1;
    }
    if (low === 0)
        return 0;
    if (low === arr.length)
        return arr.length - 1;
    return Math.abs(arr[low] - value) < Math.abs(arr[low - 1] - value)
        ? low
        : low - 1;
}
function sendCompressorParamToDDX(faderIndex, compressorParamKey, displayedValue, value) {
    const fnCode = ddxCompressorCodeMap[compressorParamKey];
    if (fnCode == null) {
        return;
    }
    if (compressorParamKey === "ATTACK") {
        let ms = displayedValue ? parseFloat(displayedValue) : 0;
        if (!displayedValue.includes("ms") && displayedValue.includes("s")) {
            ms *= 1000;
        }
        if (ms < 0) {
            ms = 0;
        }
        else if (ms > 200) {
            ms = 200;
        }
        const sysExValue = Math.round(ms);
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExValue);
    }
    else if (compressorParamKey === "RELEASE") {
        let ms = displayedValue ? parseFloat(displayedValue) : 0;
        if (!displayedValue.includes("ms") && displayedValue.includes("s")) {
            ms *= 1000;
        }
        if (ms < 20) {
            ms = 20;
        }
        else if (ms > 5000) {
            ms = 5000;
        }
        const sysExValue = Math.round(255 * (Math.log(ms / 20) / Math.log(250)));
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExValue);
    }
    else if (compressorParamKey === "THRESHOLD") {
        let dbThreshold = displayedValue ? parseFloat(displayedValue) : 0;
        let isInf = displayedValue.includes("Inf");
        if (dbThreshold < -60 || isInf) {
            dbThreshold = -60;
        }
        else if (dbThreshold > 0) {
            dbThreshold = 0;
        }
        const sysExVolume = Math.round(dbThreshold + 60);
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExVolume);
    }
    else if (compressorParamKey === "OUTPUT") {
        let outputGainDb = displayedValue ? parseFloat(displayedValue) : 0;
        if (outputGainDb < 0) {
            outputGainDb = 0;
        }
        else if (outputGainDb > 24) {
            outputGainDb = 24;
        }
        const sysExVolume = Math.round(outputGainDb);
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExVolume);
    }
    else if (compressorParamKey === "RATIO") {
        let ratio = displayedValue ? parseFloat(displayedValue.split(":")[0]) || 1 : 1;
        if (ratio < 1) {
            ratio = 1;
        }
        else if (ratio > 100 || !Number.isFinite(ratio)) {
            ratio = 100;
        }
        const sysExRatio = nearestKeyIndex(ratio, Object.keys(DDXtoBitwigRatioMap));
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExRatio);
    }
}
/// From Delay
function sendDelayParamToDDX(faderIndex, delayParamKey, displayedValue, value) {
    const fnCode = ddxDelayCodeMap[delayParamKey];
    if (fnCode == null) {
        return;
    }
    if (delayParamKey === "TIME") {
        let ms = displayedValue ? parseFloat(displayedValue) : 0;
        if (!displayedValue.includes("ms") && displayedValue.includes("s")) {
            ms *= 1000;
        }
        if (ms < 0) {
            ms = 0;
        }
        else if (ms > 300) {
            ms = 300;
        }
        const samples = ms / delaySampleInMs;
        const sysExValue = Math.round(Math.sqrt(samples));
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExValue);
    }
    else if (delayParamKey === "FEEDBACK") {
        const sysExValue = 90 + Math.round((value * 1.8 - 0.9) * 100);
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExValue);
    }
    else if (delayParamKey === "MIX") {
        const sysExValue = Math.round(value * 100);
        sendSysExDeviceToMixer(faderIndex, fnCode, sysExValue);
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
function setBitwigFaderVolumeBySysexValue(faderIndex, sysexVolume, settingsFaderValueMapping) {
    try {
        const track = getTrack(faderIndex);
        let normalizedVolume;
        if (settingsFaderValueMapping === "exact") {
            const dbValue = sysexVolume / 16 - 80;
            normalizedVolume = dbToNormalized(dbValue);
        }
        else {
            normalizedVolume = sysexVolume / 1472;
        }
        track.volume().setImmediately(normalizedVolume);
        lastFaderReceiveAction[faderIndex] = Date.now();
    }
    catch (error) {
        host.errorln(`Could not set Bitwig fader volume by sysex ${error}`);
    }
}
function setBitwigSendVolume(faderIndex, sendIndex, sysexVolume) {
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
function setBitwigSendPrePost(faderIndex, sendIndex, isPost) {
    const track = getTrack(faderIndex);
    const sendItem = track.sendBank().getItemAt(sendIndex);
    if (sendItem) {
        sendItem.sendMode().set(isPost ? "POST" : "PRE");
    }
}
function setBitwigTrackMute(faderIndex, isMuted) {
    const track = getTrack(faderIndex);
    track.mute().set(isMuted);
}
function setBitwigFaderPanBySysexValue(faderIndex, sysexPan) {
    try {
        const track = getTrack(faderIndex);
        if (faderIndex === MASTER_FADER_INDEX_L ||
            faderIndex === MASTER_FADER_INDEX_L + 1) {
            sysexPan = 60 - sysexPan;
        }
        const panValue = -1 + sysexPan / 30;
        track.pan().setRaw(panValue);
        lastPanReceiveAction[faderIndex] = Date.now();
    }
    catch (error) {
        host.errorln(`Could not set Bitwig fader pan by sysex ${error}`);
    }
}
function selectBitwigFaderAndCloseOpenGroup(faderIndex, groupIsOpen) {
    const track = trackBank.getItemAt(faderIndex);
    track.selectInEditor();
    track.makeVisibleInArranger();
    track.makeVisibleInMixer();
    if (track.isGroup()) {
        track.isGroupExpanded().set(groupIsOpen);
    }
}
//// to EQ-2
function setBitwigHighPassIsEnabled(faderIndex, isEnabled) {
    const { device } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-2"]);
    if (device) {
        device.isEnabled().set(isEnabled);
        device.isExpanded().set(isEnabled);
        lastDeviceReceiveAction[`${faderIndex}25`] = Date.now();
    }
}
function setBitwigHighPassFreq(faderIndex, fnCode, sysexValue) {
    const bandIndex = ddxEq2FnCodeMap.freq.indexOf(fnCode);
    if (bandIndex < 0) {
        return;
    }
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-2"]);
    if (device) {
        let freq = 4 * Math.pow(100, sysexValue / 80);
        if (freq > 20000) {
            freq = 20000;
        }
        else if (freq < 20) {
            freq = 20;
        }
        const param = params[`LO_FREQ`];
        param.setImmediately(freqToNormalized(freq));
        const paramType = params[`TYPE1`];
        paramType.setImmediately(1 / 3);
        const paramQ = params[`LO_Q`];
        paramQ.setImmediately(qToNormalized(0.71));
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
//// to EQ-5
function setBitwigEQIsEnabled(faderIndex, isEnabled) {
    const { device } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-5"]);
    if (device) {
        device.isEnabled().set(isEnabled);
        device.isExpanded().set(isEnabled);
        lastDeviceReceiveAction[`${faderIndex}14`] = Date.now();
    }
}
function freqToNormalized(freq) {
    return (Math.log(freq) - Math.log(20)) / (Math.log(20000) - Math.log(20));
}
function setBitwigEQFreq(faderIndex, fnCode, sysexValue) {
    const bandIndex = ddxEq5FnCodeMap.freq.indexOf(fnCode);
    if (bandIndex < 0) {
        return;
    }
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-5"]);
    if (device) {
        let freq = 20 * Math.pow(1000, sysexValue / 159);
        if (freq > 20000) {
            freq = 20000;
        }
        else if (freq < 20) {
            freq = 20;
        }
        const param = params[`FREQ${bandIndex + 1}`];
        param.setImmediately(freqToNormalized(freq));
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function setBitwigEQGain(faderIndex, fnCode, sysexValue) {
    const bandIndex = ddxEq5FnCodeMap.gain.indexOf(fnCode);
    if (bandIndex < 0) {
        return;
    }
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-5"]);
    if (device) {
        let volDb = sysexValue / 2 - 18;
        const param = params[`GAIN${bandIndex + 1}`];
        param.setImmediately((volDb - -24) / (24 - -24));
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function qToNormalized(q) {
    return (Math.log(q) - Math.log(0.1)) / (Math.log(39.81) - Math.log(0.1));
}
function setBitwigEQQ(faderIndex, fnCode, sysexValue) {
    const bandIndex = ddxEq5FnCodeMap.q.indexOf(fnCode);
    if (bandIndex < 0) {
        return;
    }
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-5"]);
    if (device) {
        const q = 0.1 * Math.pow(100, sysexValue / 40);
        const param = params[`Q${bandIndex + 1}`];
        param.setImmediately(qToNormalized(q));
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function setBitwigEQType(faderIndex, fnCode, sysexValue) {
    const bandIndex = ddxEq5FnCodeMap.type.indexOf(fnCode);
    if (bandIndex < 0) {
        return;
    }
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["EQ-5"]);
    if (device) {
        // Band
        let type = 2 / 3;
        // Cut (2-Pole)  || 4-Pole would be type = 1/3
        if (sysexValue === 1) {
            type = 0;
            // Shelve
        }
        else if (sysexValue === 2) {
            type = 1;
        }
        const param = params[`TYPE${bandIndex + 1}`];
        param.setImmediately(type);
        // Reset Q to be aligned with DDX display - Regression, but determinism is better
        if (type === 0) {
            const param = params[`Q${bandIndex + 1}`];
            param.setImmediately(qToNormalized(0.71));
        }
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
//// to Gate
function setBitwigGateIsEnabled(faderIndex, isEnabled) {
    const { device } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Gate);
    if (device) {
        device.isEnabled().set(isEnabled);
        device.isExpanded().set(isEnabled);
        lastDeviceReceiveAction[`${faderIndex}32`] = Date.now();
    }
}
function gateDbToNorm(dB) {
    return 0.996 * Math.pow(10, 0.01664 * dB);
}
function setBitwigGateThreshold(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Gate);
    if (device) {
        let volDb = -90 + sysexValue;
        const param = params[`THRESHOLD_LEVEL`];
        param.setImmediately(gateDbToNorm(volDb));
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function setBitwigGateRange(faderIndex, fnCode, sysexValue) {
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
function setBitwigGateAttack(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Gate);
    if (device) {
        let ms = sysexValue;
        if (ms >= 100) {
            ms = 100;
        }
        else if (ms < 0.1) {
            ms = 0.1;
        }
        const normed = Math.min(Math.max((Math.log(ms) - Math.log(0.1)) / (Math.log(100) - Math.log(0.1)), 0), 1);
        const param = params[`ATTACK`];
        param.setImmediately(normed);
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function setBitwigGateRelease(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Gate);
    if (device) {
        let ms = 20 * Math.pow(250, sysexValue / 255);
        if (ms >= 1000) {
            ms = 1000;
        }
        else if (ms < 1) {
            ms = 1;
        }
        const normed = Math.min(Math.max(Math.log(ms) / Math.log(1000), 0), 1);
        const param = params[`RELEASE`];
        param.setImmediately(normed);
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
//// to Compressor
function setBitwigCompressorIsEnabled(faderIndex, isEnabled) {
    const { device } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Compressor);
    if (device) {
        device.isEnabled().set(isEnabled);
        device.isExpanded().set(isEnabled);
        lastDeviceReceiveAction[`${faderIndex}28`] = Date.now();
    }
}
function ratioToNorm(ratio) {
    return Math.min(Math.max(0.27627208 * Math.pow(Math.log10(ratio), 3) -
        1.31518417 * Math.pow(Math.log10(ratio), 2) +
        1.98567827 * Math.log10(ratio), 0), 1);
}
function setBitwigCompressorRatio(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Compressor);
    if (device) {
        let index = sysexValue;
        if (index > 15) {
            index = 15;
        }
        else if (index < 0) {
            index = 0;
        }
        const param = params[`RATIO`];
        param.setImmediately(Object.values(DDXtoBitwigRatioMap)[index]);
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function setBitwigCompressorOutput(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Compressor);
    if (device) {
        let dB = sysexValue;
        if (dB > 20) {
            dB = 20;
        }
        else if (dB < 0) {
            dB = 0;
        }
        const normed = (dB + 20) / 40;
        const param = params[`OUTPUT`];
        param.setImmediately(normed);
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function setBitwigCompressorThreshold(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Compressor);
    if (device) {
        let dB = -60 + sysexValue;
        if (dB > 0) {
            dB = 0;
        }
        else if (dB < -60) {
            dB = -60;
        }
        const normed = Math.min(Math.max((dB + 60) / 60, 0), 1);
        const param = params[`THRESHOLD`];
        param.setImmediately(normed);
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function setBitwigCompressorAttack(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Compressor);
    if (device) {
        let ms = sysexValue;
        if (ms >= 70.8) {
            ms = 70.8;
        }
        else if (ms < 0.20) {
            ms = 0.20;
        }
        const normed = (Math.log(ms) - Math.log(0.20)) / (Math.log(70.8) - Math.log(0.20));
        const param = params[`ATTACK`];
        param.setImmediately(normed);
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function setBitwigCompressorRelease(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds.Compressor);
    if (device) {
        let ms = 20 * Math.pow(250, sysexValue / 255);
        if (ms >= 1410) {
            ms = 1410;
        }
        else if (ms < 38.9) {
            ms = 38.9;
        }
        const normed = Math.min(Math.max((Math.log(ms) - Math.log(38.9)) / (Math.log(1410) - Math.log(38.9)), 0), 1);
        const param = params[`RELEASE`];
        param.setImmediately(normed);
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
//// to Delay-1
function setBitwigDelayIsEnabled(faderIndex, isEnabled) {
    const { device } = getFirstDeviceById(faderIndex, BitwigDeviceIds["Delay-1"]);
    if (device) {
        device.isEnabled().set(isEnabled);
        device.isExpanded().set(isEnabled);
        lastDeviceReceiveAction[`${faderIndex}3C`] = Date.now();
    }
}
const delaySampleInMs = 300 / 13225;
function setBitwigDelayTime(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["Delay-1"]);
    if (device) {
        let samples = sysexValue * sysexValue;
        // 0ms - 300ms
        let ms = delaySampleInMs * samples;
        if (ms >= 5000) {
            ms = 5000;
        }
        else if (ms < 10) {
            ms = 10;
        }
        const normed = Math.min(Math.max((ms - 10) / (5000 - 10), 0), 1);
        const param = params[`TIME`];
        param.setImmediately(normed);
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function setBitwigDelayFeedback(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["Delay-1"]);
    if (device) {
        let percentage = -90 + sysexValue;
        if (percentage >= 90) {
            percentage = 90;
        }
        else if (percentage < -90) {
            percentage = -90;
        }
        const normed = (percentage / 100 + 0.9) / 1.8;
        const param = params[`FEEDBACK`];
        param.setImmediately(normed);
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function setBitwigDelayMix(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["Delay-1"]);
    if (device) {
        let percentage = sysexValue; // 0 - 100%
        const normed = Math.min(Math.max(percentage / 100, 0), 1);
        const param = params[`MIX`];
        param.setImmediately(normed);
        lastDeviceReceiveAction[`${faderIndex}${fnCode}`] = Date.now();
    }
}
function setBitwigDelayPhase(faderIndex, fnCode, sysexValue) {
    const { device, params } = getFirstDeviceById(faderIndex, BitwigDeviceIds["Delay-1"]);
    if (device) {
        let polarity = sysexValue;
        println(`POLARITY ${polarity}`);
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
function processIncomingSysex(sysexData) {
    const settingsMidiChannel = getMidiChannel();
    const settingsFaderValueMapping = faderValueMappingSetting.get();
    const regexp = /f0002032([0-F]{2})0b([0-F]{2})([0-F]{2})(.*)F7/gim;
    const [, midiChannel, functionType, msgCount, messagesString] = regexp.exec(sysexData);
    const messages = messagesString.match(/.{1,8}/g);
    if (settingsMidiChannel !== undefined &&
        parseInt(midiChannel, 16) !== settingsMidiChannel) {
        // println(
        //   `Incoming midi channel ${
        //     parseInt(midiChannel, 16) + 1
        //   } does not match set channel ${settingsMidiChannel + 1}.`
        // );
        return;
    }
    println(`Midi Channel: ${midiChannel} fnType: ${functionType} msgCount: ${msgCount} messages: ${messages.join("|")}`);
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
            const [, faderIndex, functionCode, highWord, lowWord] = paramRegex.exec(message);
            let sysexValue = Number((parseInt(highWord, 16) << 7) | parseInt(lowWord, 16));
            println(`faderIndex: ${faderIndex} fnCode: ${functionCode} highWord: ${highWord} lowWord: ${lowWord} sysexValue: ${sysexValue}`);
            if (isNaN(sysexValue)) {
                return;
            }
            let faderIndexInt = parseInt(faderIndex, 16);
            const normalFader = NUM_FADERS + NUM_EFFECT_FADERS - 1;
            // Map the FX1-4 mutes to the channels 5-8 on the FX tracks
            if (functionCode === "02") {
                if (faderIndexInt === normalFader + 1) {
                    faderIndexInt = normalFader + 1 - 4;
                }
                else if (faderIndexInt === normalFader + 3) {
                    faderIndexInt = normalFader + 3 - 5;
                }
                else if (faderIndexInt === normalFader + 5) {
                    faderIndexInt = normalFader + 5 - 6;
                }
                else if (faderIndexInt === normalFader + 7) {
                    faderIndexInt = normalFader + 7 - 7;
                }
            }
            if ((faderIndexInt > normalFader && faderIndexInt < MASTER_FADER_INDEX_L) ||
                faderIndexInt > MASTER_FADER_INDEX_L + 1) {
                return;
            }
            // Volume
            if (functionCode === "01") {
                setBitwigFaderVolumeBySysexValue(faderIndexInt, sysexValue, settingsFaderValueMapping);
                // Mute
            }
            else if (functionCode === "02") {
                setBitwigTrackMute(faderIndexInt, !!sysexValue);
                // Pan
            }
            else if (functionCode === "03") {
                setBitwigFaderPanBySysexValue(faderIndexInt, sysexValue);
                // Select track and close/open group
            }
            else if (functionCode === "04") {
                selectBitwigFaderAndCloseOpenGroup(faderIndexInt, !sysexValue);
                // Sends Aux1,2,3,4 Fx1,2,3,4
            }
            else if (sendsFunctionCodes.includes(functionCode.toUpperCase())) {
                setBitwigSendVolume(faderIndexInt, sendsFunctionCodes.indexOf(functionCode.toUpperCase()), sysexValue);
                // Toggle Aux1,2,3,4 PRE/POST
            }
            else if (sendsPostPreFunctionCodes.includes(functionCode.toUpperCase())) {
                setBitwigSendPrePost(faderIndexInt, sendsPostPreFunctionCodes.indexOf(functionCode.toUpperCase()), !sysexValue);
                // EQ on/off, etc..
            }
            else if (functionCode === "14") {
                setBitwigEQIsEnabled(faderIndexInt, !!sysexValue);
            }
            else if (ddxEq5FnCodeMap.freq.includes(functionCode.toUpperCase())) {
                setBitwigEQFreq(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (ddxEq5FnCodeMap.gain.includes(functionCode.toUpperCase())) {
                setBitwigEQGain(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (ddxEq5FnCodeMap.q.includes(functionCode.toUpperCase())) {
                setBitwigEQQ(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (ddxEq5FnCodeMap.type.includes(functionCode.toUpperCase())) {
                setBitwigEQType(faderIndexInt, functionCode.toUpperCase(), sysexValue);
                // High Pass on/off, etc..
            }
            else if (functionCode === "25") {
                setBitwigHighPassIsEnabled(faderIndexInt, !!sysexValue);
            }
            else if (ddxEq2FnCodeMap.freq.includes(functionCode.toUpperCase())) {
                setBitwigHighPassFreq(faderIndexInt, functionCode.toUpperCase(), sysexValue);
                // Gate on/off, etc..
            }
            else if (functionCode === "32") {
                setBitwigGateIsEnabled(faderIndexInt, !!sysexValue);
            }
            else if (getParamKeyByFnCode(ddxGateCodeMap, functionCode.toUpperCase()) === "THRESHOLD_LEVEL") {
                setBitwigGateThreshold(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (getParamKeyByFnCode(ddxGateCodeMap, functionCode.toUpperCase()) === "DEPTH") {
                setBitwigGateRange(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (getParamKeyByFnCode(ddxGateCodeMap, functionCode.toUpperCase()) === "ATTACK") {
                setBitwigGateAttack(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (getParamKeyByFnCode(ddxGateCodeMap, functionCode.toUpperCase()) === "RELEASE") {
                setBitwigGateRelease(faderIndexInt, functionCode.toUpperCase(), sysexValue);
                // Compressor on/off, etc..
            }
            else if (functionCode === "28") {
                setBitwigCompressorIsEnabled(faderIndexInt, !!sysexValue);
            }
            else if (getParamKeyByFnCode(ddxCompressorCodeMap, functionCode.toUpperCase()) === "THRESHOLD") {
                setBitwigCompressorThreshold(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (getParamKeyByFnCode(ddxCompressorCodeMap, functionCode.toUpperCase()) === "OUTPUT") {
                setBitwigCompressorOutput(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (getParamKeyByFnCode(ddxCompressorCodeMap, functionCode.toUpperCase()) === "ATTACK") {
                setBitwigCompressorAttack(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (getParamKeyByFnCode(ddxCompressorCodeMap, functionCode.toUpperCase()) === "RELEASE") {
                setBitwigCompressorRelease(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (getParamKeyByFnCode(ddxCompressorCodeMap, functionCode.toUpperCase()) === "RATIO") {
                setBitwigCompressorRatio(faderIndexInt, functionCode.toUpperCase(), sysexValue);
                // Delay on/off, etc..
            }
            else if (functionCode.toUpperCase() === "3C") {
                setBitwigDelayIsEnabled(faderIndexInt, !!sysexValue);
            }
            else if (getParamKeyByFnCode(ddxDelayCodeMap, functionCode.toUpperCase()) === "TIME") {
                setBitwigDelayTime(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (getParamKeyByFnCode(ddxDelayCodeMap, functionCode.toUpperCase()) === "FEEDBACK") {
                setBitwigDelayFeedback(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (getParamKeyByFnCode(ddxDelayCodeMap, functionCode.toUpperCase()) === "MIX") {
                setBitwigDelayMix(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
            else if (getParamKeyByFnCode(ddxDelayCodeMap, functionCode.toUpperCase()) === "PHASE") {
                setBitwigDelayPhase(faderIndexInt, functionCode.toUpperCase(), sysexValue);
            }
        });
    }
}
function setupDeviceBank(faderIndex, track) {
    const deviceBank = track.createDeviceBank(8);
    for (let j = 0; j < 8; j++) {
        const device = deviceBank.getItemAt(j);
        const params = {
            [BitwigDeviceIds["EQ-2"]]: Object.assign({}, eq2ParamsTemplate),
            [BitwigDeviceIds.Gate]: Object.assign({}, gateParamsTemplate),
            [BitwigDeviceIds.Compressor]: Object.assign({}, compressorParamsTemplate),
            [BitwigDeviceIds["EQ-5"]]: Object.assign({}, eq5ParamsTemplate),
            [BitwigDeviceIds["Delay-1"]]: Object.assign({}, delayParamsTemplate),
        };
        const bitwigDevices = {
            [BitwigDeviceIds["EQ-2"]]: device.createSpecificBitwigDevice(
            // @ts-expect-error
            java.util.UUID.fromString(BitwigDeviceIds["EQ-2"])),
            [BitwigDeviceIds.Gate]: device.createSpecificBitwigDevice(
            // @ts-expect-error
            java.util.UUID.fromString(BitwigDeviceIds.Gate)),
            [BitwigDeviceIds.Compressor]: device.createSpecificBitwigDevice(
            // @ts-expect-error
            java.util.UUID.fromString(BitwigDeviceIds.Compressor)),
            [BitwigDeviceIds["EQ-5"]]: device.createSpecificBitwigDevice(
            // @ts-expect-error
            java.util.UUID.fromString(BitwigDeviceIds["EQ-5"])),
            [BitwigDeviceIds["Delay-1"]]: device.createSpecificBitwigDevice(
            // @ts-expect-error
            java.util.UUID.fromString(BitwigDeviceIds["Delay-1"])),
        };
        device.name().markInterested();
        device.name().addValueObserver((name) => {
            // println(`${i}-${j} NAME ${name}`);
            if (isDevice(name, BitwigDeviceIds["EQ-5"])) {
                setDevice(faderIndex, j, BitwigDeviceIds["EQ-5"], device, params[BitwigDeviceIds["EQ-5"]]);
                host.scheduleTask(() => {
                    sendSysExDeviceToMixer(faderIndex, "14", device.isEnabled().getAsBoolean() ? 1 : 0);
                    Object.entries(params[BitwigDeviceIds["EQ-5"]]).forEach(([eqParamKey, eqParam]) => {
                        sendEQ5ParamToDDX(faderIndex, eqParamKey, eqParam.displayedValue().get(), eqParam.value().get());
                    });
                }, 0);
            }
            else if (isDevice(name, BitwigDeviceIds.Gate)) {
                setDevice(faderIndex, j, BitwigDeviceIds.Gate, device, params[BitwigDeviceIds.Gate]);
                host.scheduleTask(() => {
                    sendSysExDeviceToMixer(faderIndex, "32", device.isEnabled().getAsBoolean() ? 1 : 0);
                    Object.entries(params[BitwigDeviceIds.Gate]).forEach(([paramKey, param]) => {
                        sendGateParamToDDX(faderIndex, paramKey, param.displayedValue().get(), param.value().get());
                    });
                }, 0);
            }
            else if (isDevice(name, BitwigDeviceIds.Compressor)) {
                setDevice(faderIndex, j, BitwigDeviceIds.Compressor, device, params[BitwigDeviceIds.Compressor]);
                host.scheduleTask(() => {
                    sendSysExDeviceToMixer(faderIndex, "28", device.isEnabled().getAsBoolean() ? 1 : 0);
                    Object.entries(params[BitwigDeviceIds.Compressor]).forEach(([paramKey, param]) => {
                        sendCompressorParamToDDX(faderIndex, paramKey, param.displayedValue().get(), param.value().get());
                    });
                }, 0);
            }
            else if (isDevice(name, BitwigDeviceIds["EQ-2"])) {
                setDevice(faderIndex, j, BitwigDeviceIds["EQ-2"], device, params[BitwigDeviceIds["EQ-2"]]);
                host.scheduleTask(() => {
                    sendSysExDeviceToMixer(faderIndex, "25", device.isEnabled().getAsBoolean() ? 1 : 0);
                    Object.entries(params[BitwigDeviceIds["EQ-2"]]).forEach(([eqParamKey, eqParam]) => {
                        sendHighPassParamToDDX(faderIndex, eqParamKey, eqParam.displayedValue().get(), eqParam.value().get());
                    });
                }, 0);
            }
            else if (isDevice(name, BitwigDeviceIds["Delay-1"])) {
                setDevice(faderIndex, j, BitwigDeviceIds["Delay-1"], device, params[BitwigDeviceIds["Delay-1"]]);
                host.scheduleTask(() => {
                    sendSysExDeviceToMixer(faderIndex, "3C", device.isEnabled().getAsBoolean() ? 1 : 0);
                    Object.entries(params[BitwigDeviceIds["Delay-1"]]).forEach(([paramKey, param]) => {
                        sendDelayParamToDDX(faderIndex, paramKey, param.displayedValue().get(), param.value().get());
                    });
                }, 0);
            }
            else {
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
                        sendEQ5ParamToDDX(faderIndex, paramKey, param.displayedValue().get(), param.value().get());
                    }
                    else if (isDevice(device.name().get(), BitwigDeviceIds.Gate)) {
                        sendGateParamToDDX(faderIndex, paramKey, param.displayedValue().get(), param.value().get());
                    }
                    else if (isDevice(device.name().get(), BitwigDeviceIds.Compressor)) {
                        sendCompressorParamToDDX(faderIndex, paramKey, param.displayedValue().get(), param.value().get());
                    }
                    else if (isDevice(device.name().get(), BitwigDeviceIds["EQ-2"])) {
                        sendHighPassParamToDDX(faderIndex, paramKey, param.displayedValue().get(), param.value().get());
                    }
                    else if (isDevice(device.name().get(), BitwigDeviceIds["Delay-1"])) {
                        sendDelayParamToDDX(faderIndex, paramKey, param.displayedValue().get(), param.value().get());
                    }
                });
                specificParams[paramKey] = param;
            });
        });
        device.isEnabled().markInterested();
        device.isExpanded().markInterested();
        device.isEnabled().addValueObserver((isEnabled) => {
            if (isDevice(device.name().get(), BitwigDeviceIds["EQ-5"])) {
                sendSysExDeviceToMixer(faderIndex, "14", isEnabled ? 1 : 0);
            }
            else if (isDevice(device.name().get(), BitwigDeviceIds.Gate)) {
                sendSysExDeviceToMixer(faderIndex, "32", isEnabled ? 1 : 0);
            }
            else if (isDevice(device.name().get(), BitwigDeviceIds.Compressor)) {
                sendSysExDeviceToMixer(faderIndex, "28", isEnabled ? 1 : 0);
            }
            else if (isDevice(device.name().get(), BitwigDeviceIds["EQ-2"])) {
                sendSysExDeviceToMixer(faderIndex, "25", isEnabled ? 1 : 0);
            }
            else if (isDevice(device.name().get(), BitwigDeviceIds["Delay-1"])) {
                sendSysExDeviceToMixer(faderIndex, "3C", isEnabled ? 1 : 0);
            }
        });
        // Check for available PARAM ids with that
        // device.addDirectParameterIdObserver((ids) => {
        //   println(`faderIndex ${faderIndex} deviceIndex ${j} ids ${JSON.stringify(ids)}`);
        // });
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
        .getStringSetting("Developed by Felix Gertz", "Support", 128, "Support me via https://aldipower.bandcamp.com/album/das-reihenhaus and purchase the album. Thank you so much.");
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
host.defineController(VENDOR, EXTENSION_NAME, VERSION, "57fb8818-a6a6-4a23-9413-2a1a5aea3ce1", AUTHOR);
host.setShouldFailOnDeprecatedUse(true);
host.defineMidiPorts(1, 1);
host.addDeviceNameBasedDiscoveryPair(["DDX3216"], ["DDX3216"]);
function init() {
    createBitwigSettingsUI();
    midiIn = host.getMidiInPort(0);
    midiOut = host.getMidiOutPort(0);
    trackBank = host.createMainTrackBank(NUM_FADERS, NUM_EFFECT_FADERS, 0);
    effectTrackBank = host.createEffectTrackBank(NUM_EFFECT_FADERS, NUM_EFFECT_FADERS, 0);
    masterTrack = host.createMasterTrack(0);
    registerObserver();
    midiIn.setSysexCallback((sysexData) => {
        println(`Sysex received ${sysexData} midiChannelSetting: ${midiChannelSetting.getRaw()}`);
        if (!sysexData.startsWith("f0002032")) {
            return;
        }
        processIncomingSysex(sysexData);
    });
    println(`${VENDOR} ${EXTENSION_NAME} controller script version ${VERSION} written by ${AUTHOR} initialized. This script comes under GPLv3 license.`);
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
function flush() { }
