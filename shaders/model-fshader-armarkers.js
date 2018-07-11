const modelShaderARMarkers = `#version 300 es
// Copyright 2018 Intel Corporation.
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
//
//
// Create a volumetric model out of the camera depth data. The main inputs are
// the depth data and the movement matrix that describes the movement of the
// camera since the first frame.

precision highp float;

layout(location = 0) out vec4 outTexel;

// Length of each side of the output cube texture.
uniform int cubeSize;
uniform float gridUnit;
// Depth image from the camera.
uniform highp sampler2D depthTexture;
// RGB image from the camera.
uniform highp sampler2D colorTexture;
// Which slice of the cubeTexture in the z direction we are rendering. Goes
// from 0 to (cubeSize-1).
uniform uint zslice;
// Maximum distance from a surface where we still bother updating the
// information about the distance - if too far, the weight of the new data is 0.
uniform float sdfTruncation;
// Estimated movement of the (real-world) camera.
uniform mat4 movement;
// Matrix that represents the transformation to be done between the depth data
// 3D position to the color data 3D position.
uniform mat4 depthToColor;
// Offset of the principal point of the color camera.
uniform vec2 colorOffset;
// Focal length of the color camera.
uniform vec2 colorFocalLength;

${PROJECT_DEPROJECT_SHADER_FUNCTIONS}


// Get the color for the |depth| 3D position; project onto the color video frame
// and sample from the texture. This value is to be stored in the sub-cube.
// The 'position' argument is the center of the sub-cube for which we are
// calculating this (where the 'sub-cube' is a single texel of the 3D
// cubeTexture). The cubeTexture is assumed to be centered at (0, 0, 0.5) and
// each side has length 1.
vec4 calculateColor(vec3 texelCoordinate, vec3 position) {
    // Make sure no division by 0 in projecting occurs.
    if (position.z == 0.0) {return vec4(0.0);}
    vec2 p = project(position);
    vec3 depth = deproject(depthTexture, p);
    // The depth camera stores zero if depth is undefined.
    // TODO make sure not checking this won't affect results
    if (depth.z == 0.0) {return vec4(0.0);}
    // TODO proper grid unit check.
    vec3 camera = vec3(0.0, 0.0, 0.0);
    if (depth.z < position.z - gridUnit || depth.z > position.z + gridUnit) { return vec4(0.0);}

    vec2 texCoord = p + 0.5;
    float z = float(texture(depthTexture, texCoord).r) * depthScale;
    vec2 position2d = (p - depthOffset) / depthFocalLength;
    vec3 depthPos = vec3(position2d * z, z);

    vec4 colorPos = depthToColor * vec4(depthPos, 1.0);
    position2d = colorPos.xy / colorPos.z;
    vec2 colorTextureCoord = position2d * colorFocalLength + colorOffset;
    vec4 color = texture(colorTexture, colorTextureCoord);
    return mix(color, vec4(0.0), float(coordIsOutOfRange(colorTextureCoord)));
}

// Calculate the texel coordinate for a texel with index (i, j, k).
vec3 texelCenter(uint i, uint j, uint k) {
    return vec3((float(i) + 0.5) * gridUnit,
                (float(j) + 0.5) * gridUnit,
                (float(k) + 0.5) * gridUnit);
}

void main() {
    // We are reading from the same texel as we are outputting.
    vec3 texel = texelCenter(uint(gl_FragCoord.x),
                             uint(gl_FragCoord.y),
                             zslice);
    // Convert texel coordinate where each component is from 0 to 1, into global
    // coordinates where each component is from -0.5 to 0.5, i.e. the cube
    // texture is going to be centered at the origin.
    vec3 position = texel - 0.5;
    // Center the cube at (0, 0, 0.5). The camera will be at the origin and the
    // projection plane at z=-1.
    position.z += 0.5;
    position = (movement * vec4(position, 1.0)).xyz;
    vec4 color = calculateColor(texel, position);
    if (color.a == 0.0)
        discard;
    else
        outTexel = color;
}
`;
// vim: set filetype=glsl:
