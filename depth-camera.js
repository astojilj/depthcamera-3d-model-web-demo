/*jshint esversion: 6 */

// Copyright 2017 Intel Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

DepthCamera.getStreams = async function() {
    var depth_stream = await DepthCamera.getDepthStream();
    // Usually, the color stream is of higher resolution compared to
    // the depth stream. The use case here doesn't require the highest
    // quality for color so use lower resolution if available.
    const depth = depth_stream.getVideoTracks()[0];
    var color_stream =
        await DepthCamera.getColorStreamForDepthStream(depth_stream);
    return [depth_stream, color_stream];
}

DepthCamera.getDepthStream = async function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices ||
        !navigator.mediaDevices.getUserMedia)
        throw new Error("Your browser doesn't support the mediaDevices API.");

    let constraints = {
        audio: false,
        video: {
            // We don't use videoKind as it is still under development.
            // videoKind: {exact:"depth"}, R200 related hack: prefer
            // depth (width = 628) to IR (width = 641) stream.
            width: {ideal: 628},

            // SR300 depth camera enables capture at 110 frames per
            // second.
            frameRate: {ideal: 110},
        }
    }
    let stream = await navigator.mediaDevices.getUserMedia(constraints);
    let track = stream.getVideoTracks()[0];
    if (track.label.indexOf("RealSense") == -1) {
        throw new Error(chromeVersion() < 58 ?
            "Your browser version is too old. Get Chrome version 58 or later." :
            "No RealSense camera connected.");
    }

    if (track.getSettings && track.getSettings().frameRate > 60.01) {
        // After Chrome 59, returned track is scaled to 628 and frameCount 110.
        // We got the deviceId, so we the deviceId to select the stream with
        // default resolution and frameRate.
        track.stop();
        constraints = {
            audio: false,
            video: {
                deviceId: {exact: track.getSettings().deviceId},
                frameRate: {ideal: 30}
            }
        }
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        track = stream.getVideoTracks()[0];
    }
    return stream;
}

// Call the method after getting depth_stream using getDepthStream.
DepthCamera.getColorStreamForDepthStream = async function(depth_stream) {
    // To get color stream from the same physical device providing the depth
    // stream, we will use groupId, once it is implemented:
    // See https://crbug.com/627793
    // For now, enumerate devices based on label.
    // Note: depth_stream is not used, for now, but deliberatelly added as a
    // parameter to mandate the need for previous call to getDepthStream.
    var all_devices = await navigator.mediaDevices.enumerateDevices();
    let depth_device_id = null;
    const depth = depth_stream.getVideoTracks()[0];
    // Chrome, starting with version 59, implements getSettings() API.
    if (depth.getSettings) {
        depth_device_id = depth.getSettings().deviceId;
    } else if (ideal_width) {
        console.warn(`Not able to set ideal width for color video as
            MediaStreamTrack getSettings() API is not available. Try
            with Chromium version > 59.`);
    }
    const devices = (navigator.appVersion.indexOf("Win") == -1)
        ? all_devices.filter((device) => (device.kind == "videoinput" &&
            device.label.indexOf("RealSense") !== -1 &&
            device.deviceId != depth_device_id))
        : all_devices.filter((device) => (device.kind == "videoinput" &&
            device.label.indexOf("RealSense") !== -1 &&
            device.label.indexOf("RGB") !== -1 &&
            device.deviceId != depth_device_id));

    if (devices.length < 1) {
        throw new Error("No RealSense camera connected.");
    }
    // Select streams from these ids, so that some other camera doesn't get
    // selected (e.g. if the user has another rgb camera).
    const ids = devices.map((device) => device.deviceId);

    // Select color stream.
    const constraints = {
        video: {
            width: 640,
            height: 480,
            deviceId: {exact: ids},
        },
    };
    var stream = await navigator.mediaDevices.getUserMedia(constraints);
    return stream;
}

// Figure out the camera intristics and extrinsics based on the depth stream
// camera model.
//
// This should be rewritten once the MediaCapture-Depth API works - don't
// hardcode the values based on camera model, but query it from the API.
//
// See the documentation at
// https://w3c.github.io/mediacapture-depth/#synchronizing-depth-and-color-video-rendering
DepthCamera.getCameraCalibration = function(depth_stream) {
    const label = depth_stream.getVideoTracks()[0].label;
    const cameraName = label.includes("R200") ? "R200"
        : (label.includes("Camera S") || label.includes("SR300")) ? "SR300"
        : label.includes("ZR300") ? "ZR300"
        : label.includes(") 4") ? "generic4"
        : label;

    var distortionModels = {
        NONE: 0,
        MODIFIED_BROWN_CONRADY: 1,
        INVERSE_BROWN_CONRADY: 2,
    };
    var result;
    if (cameraName === "R200")  {
        result = {
            depthScale: 0.001,
            getDepthIntrinsics: function(width, height) {
                if (width == 628 && height == 469) {
                    return {
                        offset: [305.558075, 233.5],
                        focalLength: [582.154968, 582.154968],
                    };
                } else if (width == 628 && height == 361) {
                    return {
                        offset: [233.3975067138671875, 179.2618865966796875],
                        focalLength: [447.320953369140625, 447.320953369140625],
                    };
                } else {
                    throw new Error("Depth intrinsics for size " + width + "x" +
                                     height + " are not available.");
                }
            },
            colorOffset: new Float32Array(
                [311.841033935546875, 229.7513275146484375]
            ),
            colorFocalLength: new Float32Array(
                [627.9630126953125, 634.02410888671875]
            ),
            // Rotation [0..2] goes to 1st column, [3..6] to second, etc. The
            // row at the bottom is translation.
            depthToColor: [
                0.99998325109481811523, 0.002231199527159333229, 0.00533978315070271492, 0,
                -0.0021383403800427913666, 0.99984747171401977539, -0.017333013936877250671, 0,
                -0.0053776423446834087372, 0.017321307212114334106, 0.99983555078506469727, 0,
                -0.058898702263832092285, -0.00020283895719330757856, -0.0001998419174924492836, 1
            ],
            depthDistortionModel: distortionModels.NONE,
            depthDistortioncoeffs: [0, 0, 0, 0, 0],
            colorDistortionModel: distortionModels.MODIFIED_BROWN_CONRADY,
            colorDistortioncoeffs: [
                -0.078357703983783721924,
                0.041351985186338424683,
                -0.00025565386749804019928,
                0.0012357287341728806496,
                0
            ],
        };
    } else if (cameraName === "SR300")  {
        result =  {
            depthScale: 0.0001249866472790017724,
            getDepthIntrinsics: function(width, height) {
                if (width == 640 && height == 480) {
                    return {
                        offset: [310.743988037109375, 245.1811676025390625],
                        focalLength: [475.900726318359375, 475.900726318359375],
                    };
                } else {
                    throw new Error("Depth intrinsics for size " + width + "x" +
                                     height + " are not available.");
                }
            },
            colorOffset: new Float32Array(
                [312.073974609375, 241.969329833984375]
            ),
            colorFocalLength: new Float32Array(
                [617.65087890625, 617.65093994140625]
            ),
            depthToColor: [
                0.99998641014099121094, -0.0051436689682304859161, 0.00084982655243948101997, 0,
                0.0051483912393450737, 0.99997079372406005859, -0.005651625804603099823, 0,
                -0.00082073162775486707687, 0.0056559243239462375641, 0.99998366832733154297, 0,
                0.025699997320771217346, -0.00073326355777680873871, 0.0039400043897330760956, 1
            ],
            depthDistortionModel: distortionModels.INVERSE_BROWN_CONRADY,
            depthDistortioncoeffs: [
                0.14655706286430358887,
                0.078352205455303192139,
                0.0026113723870366811752,
                0.0029218809213489294052,
                0.066788062453269958496,
            ],
            colorDistortionModel: distortionModels.NONE,
            colorDistortioncoeffs: [0, 0, 0, 0, 0],
        };
    } else if (cameraName === "ZR300")  {
        result = {
            depthScale: 0.00100000005,
            getDepthIntrinsics: function(width, height) {
                if (width == 628 && height == 469) {
                    return {
                        offset: [309.912567, 234.410904],
                        focalLength: [575.729980, 575.729980],
                    };
                } else if (width == 628 && height == 361) {
                    return {
                        offset: [238.683838, 180.205521],
                        focalLength: [445.920288, 445.920288],
                    };
                } else {
                    throw new Error("Depth intrinsics for size " + width + "x" +
                                     height + " are not available.");
                }
            },
            colorOffset: new Float32Array(
                [312.271545, 233.118652]
            ),
            colorFocalLength: new Float32Array(
                [616.316895, 617.343323]
            ),
            depthToColor: [
                0.999995947, 0.00140406948, 0.00246621366, 0,
                -0.00140700850, 0.999998271, 0.00119038881, 0,
                -0.00246453821, -0.00119385391, 0.999996245, 0,
                -0.0587307774, 7.03283295e-05, 0.000553227146, 1
            ],
            depthDistortionModel: distortionModels.NONE,
            depthDistortioncoeffs: [0, 0, 0, 0, 0],
            colorDistortionModel: distortionModels.MODIFIED_BROWN_CONRADY,
            colorDistortioncoeffs: [
                0.0727398321,
                -0.138192296,
                0.000800351670,
                0.000444319186,
                0
            ],
        };
    } else if (cameraName === "generic4")  {
        result = {
            depthScale: 0.00100000005,
            getDepthIntrinsics: function(width, height) {
                if (width == 640 && height == 480) {
                    return {
                        offset: [321.17535400390625, 248.4362640380859375],
                        focalLength: [402.60308837890625, 402.60308837890625],
                    };
                } else {
                    throw new Error("Depth intrinsics for size " + width + "x" +
                                     height + " are not available.");
                }
            },
            colorOffset: new Float32Array(
                [331.870422363281, 242.991546630859]
            ),
            colorFocalLength: new Float32Array(
                [629.172912597656, 628.130920410156]
            ),
            depthToColor: [
                0.999902248382, 0.010088876821, 0.009682051837, 0,
                -0.010075648315, 0.9999482631683, -0.001414125669, 0,
                0.009695817716, 0.001316434470, 0.99995213747, 0,
                0.036090422422,  0.000611198542174, -0.00184865354, 1
            ],
            depthDistortionModel: distortionModels.NONE,
            depthDistortioncoeffs: [0, 0, 0, 0, 0],
            colorDistortionModel: distortionModels.NONE,
            colorDistortioncoeffs: [0, 0, 0, 0, 0],
        };
    } else {
        throw {
            name: "CameraNotSupported",
            message: "Sorry, your camera '" + cameraName + "' is not supported",
        };
    }
    // This also de-normalizes the depth value (it's originally a 16-bit
    // integer normalized into a float between 0 and 1).
    result.depthScale = result.depthScale * 65535;
    return result;
}

function DepthCamera() {
}

function chromeVersion () {
    var raw = navigator.userAgent.match(/Chrom(e|ium)\/([0-9]+)\./);
    return raw ? parseInt(raw[2], 10) : false;
}
