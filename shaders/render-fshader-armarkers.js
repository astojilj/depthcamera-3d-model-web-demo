const renderShaderARMarkers = `#version 300 es
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
// Render the volumetric model created from a depth camera.
// Implemented as a raymarcher for a signed distance function which represents
// the volumetric model and is stored in a 3D texture. For each fragment,
// determine its position on the projection plane which is at z=-1. Cast a ray
// from it towards the camera and move along the ray until we reach the surface
// of the volumetric model (where the signed distance function is equal to 0).
// The model is stored in a cube (3D texture), positioned in front of the
// camera. Calculate the color of the surface using Phong lightning and return
// that as the output.
// http://www.alanzucconi.com/2016/07/01/raymarching/
//
//                          ^ x
//                          |
//                          | +-------------+
//             |            | |             |
//             |            | |  volumetric |
//             |      camera| |    model    |
//           --|------------+--------------------->
//           -1|           0| |             |      z
//             |            | |             |
//             |            | |             |
//         projection       | +-------------+
//          plane           |

// How many steps the raymarcher will take at most.
#define MAX_STEPS 1024
// Floats with a difference smaller than this are considered equal.
#define EPSILON 0.000001

#define LIGHT_POSITION vec3(1.0, 0.8, -0.8)
#define LIGHT_COLOR vec3(1.0, 1.0, 1.0)
#define AMBIENT_LIGHT_STRENGTH 0.5
#define SPECULAR_LIGHT_STRENGTH 0.2
#define SPECULAR_LIGHT_SHININESS 128.0

precision highp float;

out vec4 outColor;

uniform highp sampler3D cubeTexture;
// this should be 1.0/CUBE_SIZE, i.e. the side length of each sub-cube
uniform float gridUnit;
uniform mat4 viewMatrix;
uniform uvec2 canvasSize;

// Convert world coordinates of the cube into uvw texture coordinates. Imagine
// there is a cube of size 1x1x1 at origin - this function will return the
// coordinate of the texel as if the texture was positioned like that.
vec3 getTexelCoordinate(vec3 position) {
    return position + 0.5;
}

vec4 getColor(vec3 position) {
    // Move the cube to the front of the camera so that it is all visible.
    position -= vec3(0.0, 0.0, 1.1);
    return texture(cubeTexture, getTexelCoordinate(position));
}

/*
// Guess what the normal of the surface is at this position by looking at nearby
// points on the surface.
vec3 estimateNormal(vec3 position) {
    vec3 normal;
    float unit = gridUnit/2.0;
    normal.x = signedDistance(position + vec3(unit, 0.0, 0.0))
             - signedDistance(position - vec3(unit, 0.0, 0.0));
    normal.y = signedDistance(position + vec3(0.0, unit, 0.0))
             - signedDistance(position - vec3(0.0, unit, 0.0));
    normal.z = signedDistance(position + vec3(0.0, 0.0, unit))
             - signedDistance(position - vec3(0.0, 0.0, unit));
    return normalize(normal);
}

// Calculate Phong lighting for a single point at 'position'.
// https://learnopengl.com/#!Lighting/Basic-Lighting
vec4 light(vec3 position, vec3 normal, vec3 viewDirection) {
    vec3 lightDirection = normalize(LIGHT_POSITION - position);
    vec3 reflectionDirection = reflect(lightDirection, normal);
    // color information is packed within two floats.
    position -= vec3(0.0, 0.0, 1.1);
    vec2 color = texture(cubeTexture, getTexelCoordinate(position)).ba;
    vec3 objectColor = vec3(fract(color), color.r / 255.0); 
    // objectColor = vec3(0.5, 0.5, 0.5);

    vec3 ambient = AMBIENT_LIGHT_STRENGTH * LIGHT_COLOR;
    vec3 diffuse = max(dot(normal, lightDirection), 0.0) * LIGHT_COLOR;
    float spec = pow(max(dot(viewDirection, reflectionDirection), 0.0),
                     SPECULAR_LIGHT_SHININESS);
    vec3 specular = SPECULAR_LIGHT_STRENGTH * spec * LIGHT_COLOR;
    return vec4(objectColor * (ambient + diffuse + specular), 1.0);
}

// Return the color of the object at this position.
vec4 renderSurface(vec4 color, vec3 position, vec3 viewDirection) {
    vec3 normal = estimateNormal(position);
    return light(position, normal, viewDirection);
}
*/
// Cast a ray from the position in the projection plane (the 'position'
// parameter) in the direction of 'viewDirection'.
// Move along the ray by a step equal to the distance to the nearest surface,
// given by the signed distance function, until we hit some surface.
// Once we hit a surface, calculate the color of it in that position and return
// it.
// http://www.alanzucconi.com/2016/07/01/raymarching/
vec4 raymarch(vec3 position, vec3 viewDirection) {
    vec3 step = gridUnit * viewDirection;
    position = position + 0.5 * viewDirection; // 50 cm away to reduce stepping.
    for (int i = 0; i < MAX_STEPS; i++) {
        vec4 color = getColor(position);
        if (color.a != 0.0) {
            return color; // renderSurface(color, position, viewDirection);
        } else if (length(position) > 10.0) {
            // we are way outside of the cube texture, don't bother anymore
            break;
        } else {
            position += step;
        }
    }
    return vec4(0.0, 0.0, 0.0, 1.0);
}


void main() {
    // Each pixel/fragment gets a coordinate between (-0.5, -0.5) and (0.5,
    // 0.5). Flip the x coordinate, because projection onto the plane at z=-1
    // will cause it to get switched.
    float size = float(max(canvasSize.x, canvasSize.y));
    vec2 coord = vec2(-(float(gl_FragCoord.x) - float(canvasSize.x)/2.0)/size,
                      (float(gl_FragCoord.y) - float(canvasSize.y)/2.0)/size);
    // The projection plane is at z=-1 and the camera at origin.
    vec4 position = viewMatrix * vec4(coord, -1.0, 1.0);
    vec4 camera = viewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    // Cast a ray from our position at the projection plane to the camera.
    vec4 viewDirection = normalize(camera - position);
    outColor = raymarch(position.xyz, viewDirection.xyz);
}
`;
// vim: set filetype=glsl:
