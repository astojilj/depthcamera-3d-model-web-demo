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

const READ_FULL_PIXELS = false;
const READ_FLOAT_PIXELS = true;
const READ_MAPPED_FULL_PIXELS = true;

let readBuffer = null;
const width = 640;
const height = 480;
let ctx2d = null;

_readPixels = (gl) => {
  readBuffer = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, readBuffer);        
}

_putReadPixelsTo2DCanvas = () => {
  if (!ctx2d)
    ctx2d = document.getElementById('canvas2D').getContext('2d');
  const img = ctx2d.getImageData(0, 0, width, height);
  const data = img.data;
  for (let i = 0, length = data.length; i < length; i++) {  
    data[i] = readBuffer[i];
  }
  ctx2d.putImageData(img, 0, 0);
}

_putReadFullFloatPixelsTo2DCanvas = () => {
  if (!ctx2d)
    ctx2d = document.getElementById('canvas2D').getContext('2d');
  const img = ctx2d.getImageData(0, 0, width, height);
  const data = img.data;
  for (let i = 0, length = data.length; i < length; i+=4) {  
    data[i] = readBuffer[i +3] * 255;
    data[i + 1] = readBuffer[i + 3] * 255;
    data[i + 2] = readBuffer[i + 3] * 255;
    data[i + 3] = 255;
  }
  ctx2d.putImageData(img, 0, 0);
}

_readFloatPixels = (gl, w, h) => {
  readBuffer = new Float32Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, readBuffer);        
}

_putReadFloatPixelsTo2DCanvas = (w, h) => {
  if (!ctx2d)
    ctx2d = document.getElementById('canvas2D').getContext('2d');
  if (!READ_FULL_PIXELS && !READ_MAPPED_FULL_PIXELS)
    ctx2d.clearRect(0, 0, width, height);
  for (let j = 0; j < h; j++) {
    const row = j * w * 4;
    const rend = (j + 1) * w * 4;
    for (let i = row; i < rend; i+=4) {
      if (readBuffer[i] != 0.0 && readBuffer[i+1] != 0.0) {
        // Calculate the pixel.
        let x = (((readBuffer[i] % 1.0) * width) | 0) + 3;
        let y = (((readBuffer[i+1] % 1.0) * height) | 0) + 3;

        const index = (readBuffer[i] | 0) >> 10;
        
        if (readBuffer[i+2] != 0 && readBuffer[i+3] != 0) {
          ctx2d.beginPath();
          ctx2d.fillStyle = "#00FFFF";
          ctx2d.fillRect(x, y, 2, 2);
          ctx2d.stroke();

          ctx2d.beginPath();
          ctx2d.strokeStyle = "#FF0000";
          ctx2d.moveTo(x, y);

          const x1 = (((readBuffer[i+2] % 1.0)* width) | 0) + 3;
          const y1 = (((readBuffer[i+3] % 1.0) * height) | 0 + 3);
          ctx2d.lineTo(x1, y1);

          ctx2d.fillStyle = "#FFA500";
          ctx2d.fillRect(x1, y1, 2, 2);

          // Now, check if the rest of pixels are available in integer part:
          if (readBuffer[i+1] > 1.0 || readBuffer[i+2] > 1.0) {
            const x2 = (readBuffer[i] | 0) & 0x3FF;
            const y2 = readBuffer[i+1] | 0;
            ctx2d.lineTo(x2, y2);
            const x3 = readBuffer[i+2] | 0;
            const y3 = readBuffer[i+3] | 0;
            ctx2d.lineTo(x3, y3);
          }
          ctx2d.stroke();
        }
      }
    }
  }
}

function initializeMovementCalculus(gl, programs, textures, framebuffers, cameraParams, width, height) {

  // Remove original passes used for rendering detected markers as we won't
  // need them and add another pass that would, using depth camera, calculate
  // 3D position of AR marker square.
  // first pass would be mapping depth to color for all pixels.
  const depthToColorVertex = `#version 300 es
    precision highp float;
    uniform float depthScale;
    uniform vec2 depthOffset;
    uniform vec2 colorOffset;
    uniform vec2 depthFocalLength;
    uniform vec2 colorFocalLength;
    uniform mat4 depthToColor;
    uniform sampler2D sDepth;

    out vec4 position;

    void main(){
      // Get the texture coordinates in range from [0, 0] to [1, 1]
      vec2 depth_pixel;
      vec2 depth_texture_size = vec2(textureSize(sDepth, 0));
      depth_pixel.x = mod(float(gl_VertexID), depth_texture_size.x) + 0.5;
      depth_pixel.y = clamp(floor(float(gl_VertexID) / depth_texture_size.x),
                            0.0, depth_texture_size.y) + 0.5;
      vec2 depth_texture_coord = depth_pixel / depth_texture_size;
      float depth = texture(sDepth, depth_texture_coord).r;
      if (depth == 0.0) {
        position = vec4(0.0);
        return;
      }
      float depth_scaled = depthScale * depth;
      // X and Y are the position within the depth texture (adjusted
      // so that it matches the position of the RGB texture), Z is
      // the depth.
      vec2 position2d = (depth_texture_coord - depthOffset) / depthFocalLength;
      vec3 depthPos = vec3(position2d * depth_scaled, depth_scaled);
      vec4 colorPos = depthToColor * vec4(depthPos, 1.0);
      
      position2d = colorPos.xy / colorPos.z;
      // color texture coordinate.
      vec2 v = position2d * colorFocalLength + colorOffset;
      position = colorPos;
      gl_Position = vec4(v.x * 2.0 - 1.0, v.y * 2.0 - 1.0, 0, 1);
    }`;
  const depthToColorPixel = `#version 300 es
    precision highp float;
    uniform sampler2D s;
    in vec4 position;
    out vec4 fragColor;

    void main() {
      // In color frame aligned texture, each pixel holds 3D position.
      fragColor = position;
    }`;
  const color = textures.color;
  const intrin = cameraParams.getDepthIntrinsics(width, height);
  const offsetx = (intrin.offset[0] / width);
  const offsety = (intrin.offset[1] / height);
  const focalx = intrin.focalLength[0] / width;
  const focaly = intrin.focalLength[1] / height;
  const coloroffsetx = cameraParams.colorOffset[0] / width;
  const coloroffsety = cameraParams.colorOffset[1] / height;
  const colorfocalx = cameraParams.colorFocalLength[0] / width;
  const colorfocaly = cameraParams.colorFocalLength[1] / height;
  const d2cTexture = ARMarker.createFloatTexture(gl, color.w, color.h);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const d2c = ARMarker.createProgram(gl, depthToColorVertex, depthToColorPixel, color, false);
  const d2cPass = {
    in: color,
    out: [d2cTexture],
    framebuffer: ARMarker.createFramebuffer2D(gl, [d2cTexture]),
    program: d2c,
    points: width * height,
    vertexAttribArray: vao
  };
  gl.useProgram(d2c);
  gl.uniform1i(gl.getUniformLocation(d2c, "sDepth"), textures.depth[0].glId());
  gl.uniform1i(gl.getUniformLocation(d2c, "s"), textures.color.glId());
  gl.uniform1f(gl.getUniformLocation(d2c, 'depthScale'), cameraParams.depthScale);
  gl.uniform2f(gl.getUniformLocation(d2c, 'depthFocalLength'), focalx, focaly);
  gl.uniform2f(gl.getUniformLocation(d2c, 'depthOffset'), offsetx, offsety);
  gl.uniform2f(gl.getUniformLocation(d2c, 'colorFocalLength'), colorfocalx, colorfocaly);
  gl.uniform2f(gl.getUniformLocation(d2c, 'colorOffset'), coloroffsetx, coloroffsety);
  gl.uniformMatrix4fv(gl.getUniformLocation(d2c, "depthToColor"), false, cameraParams.depthToColor);

  gl.bindVertexArray(gl.vao_markers);
  // We use two consecutive RGBA32F pixels in texture to hold information
  // about markers' 3D transform - double the width. 
  const t = gl.passes[5].out[0];
  const transformsTexture = ARMarker.createFloatTexture(gl, t.w, t.h);
  const transformsVertex = `#version 300 es
    precision highp float;
    in vec2 v;
    out vec2 t;

    void main(){
      gl_Position = vec4(v.x * 2.0 - 1.0, v.y * 2.0 - 1.0, 0, 1);
      t = v;
    }`;
  const transformsPixel = `#version 300 es
    precision highp float;
    uniform sampler2D s;
    uniform sampler2D sDepth;
    in vec2 t;
    out vec4 fragColor;

    void main() {
      // Viewport is 640x480, we are writing to 32x16 texture and
      // reading from 16*16.
      vec2 ts = vec2(40.0, 30.0) * t;
      // fract * 8 values are ~0.25 and ~0.75
      float even = float(fract(ts.x * 8.0) > 0.5);
      ts.x = ts.x - even * 0.0625;
      vec4 ar = texture(s, ts);
      if (even == 1.0) {
        if (ar.x == 0.0 && ar.y == 0.0) {
          fragColor = ar;
          return;
        }
        // get the depth to calculate transformation.
        fragColor = vec4(ts, ts);            
      } else {
        fragColor = ar;            
      }
    }`;
  const p = ARMarker.createProgram(gl, transformsVertex, transformsPixel, t);
  const transformCalculationPass = {
    in: t,
    out: [transformsTexture],
    framebuffer: ARMarker.createFramebuffer2D(gl, [transformsTexture]),
    program: p
  };
  gl.useProgram(p);
  gl.uniform1i(gl.getUniformLocation(p, "sDepth"), textures.depth[0].glId());
  gl.passes.splice(6, 3, d2cPass, transformCalculationPass);
}

function getCameraTransform(gl, programs, textures, framebuffers, frame) {
  gl.bindVertexArray(gl.vao_markers);  
  for (let i = 0; i < gl.passes.length; ++i) {
    const pass = gl.passes[i];
    // comment previous two lines and uncomment following to measure
    // latency of rendering only
    // { const pass = gl.passes[6];
    gl.useProgram(pass.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, pass.framebuffer);

    if(pass.points) {
      gl.bindVertexArray(gl.vertexAttribArray);
      gl.drawArrays(gl.POINTS, 0, pass.points);
      gl.bindVertexArray(gl.vao_markers);
      continue;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.vertex_buffer);
    gl.vertexAttribPointer(pass.program.vertex_location, 2, gl.FLOAT, false, 0, 0);
    
    if(pass.outlines) {
      gl.lineWidth(3);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.line_index_buffer);
      gl.drawElementsInstanced(gl.LINE_LOOP, 4, gl.UNSIGNED_SHORT, 0, pass.outlines);
    } else if (pass.codes) {  // codes
      gl.enable(gl.BLEND);
      const bound = gl.getParameter(gl.TEXTURE_BINDING_2D);
      gl.bindTexture(gl.TEXTURE_2D, gl.codes_texture);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.index_buffer);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, pass.codes);
      gl.bindTexture(gl.TEXTURE_2D, bound);
      gl.disable(gl.BLEND);
    } else {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.index_buffer);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);              
    }
  }

  // Read it back to buffer.
  if (READ_FULL_PIXELS) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.passes[2].framebuffer);
    _readPixels(gl);
    _putReadPixelsTo2DCanvas();
  }
  if (READ_MAPPED_FULL_PIXELS) {
    const map = gl.passes[6];
    gl.bindFramebuffer(gl.FRAMEBUFFER, map.framebuffer);
    _readFloatPixels(gl, map.out[0].w, map.out[0].h);
    _putReadFullFloatPixelsTo2DCanvas();
  }
  // readPixels = true;
  if (READ_FLOAT_PIXELS) {
    const pass = gl.passes[7];
    gl.bindFramebuffer(gl.FRAMEBUFFER, pass.framebuffer);
    _readFloatPixels(gl, pass.out[0].w, pass.out[0].h);
    // Put read and processed pixels to 2D canvas.
    // Note: This is just one of scenarios for the demo. You can directly
    // bind video to 2D canvas without using WebGL as intermediate step.
    // _putReadPixelsTo2DCanvas();
    _putReadFloatPixelsTo2DCanvas(pass.out[0].w, pass.out[0].h);
  }

  gl.bindVertexArray(null);
  return mat4.create();
/*    program = programs.points;
    gl.useProgram(program);
    // Swap between depth textures, so that the older one is referenced as
    // destDepthTexture.
    l = gl.getUniformLocation(program, 'sourceDepthTexture');
    gl.uniform1i(l, textures.depth[frame%2].glId());
    l = gl.getUniformLocation(program, 'destDepthTexture');
    gl.uniform1i(l, textures.depth[(frame+1)%2].glId());
    // Number of items in each texel, 4 means RGBA, 3 means RGB.
    const stride = 4;

    const movement = mat4.create();
    let previousError = 0;
    // Run the ICP algorithm until the
    // error stops changing (which usually means it converged).
    for (let step = 0; step < MAX_STEPS; step += 1) {
        // Find corresponding points and output information about them into
        // textures (i.e. the cross product, dot product, normal, error).
        program = programs.points;
        gl.useProgram(program);
        l = gl.getUniformLocation(program, 'movement');
        gl.uniformMatrix4fv(l, false, movement);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers.points);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // Use the textures created by the points shader to construct a 6x6
        // matrix A and 6x1 vector b for each point and store it into a texture.
        program = programs.matrices;
        gl.useProgram(program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers.matrices);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // Sum up the matrices and vectors from the 'matrices' shader to create
        // a single 6x6 matrix A and 6x1 vector b. Uses a tree reduction, so
        // that each loop will use a (usually) square texture with data as the
        // input and a square texture of 1/4 the size as the output. Each
        // instance of the shader sums together 4 neighboring items.
        program = programs.sum;
        gl.useProgram(program);
        l = gl.getUniformLocation(program, 'inputTexture');
        gl.uniform1i(l, textures.matrices.glId());
        for (let i = 0; i < framebuffers.sum.length; i += 1) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffers.sum[i]);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            gl.finish();
            l = gl.getUniformLocation(program, 'inputTexture');
            gl.uniform1i(l, textures.sum[i].glId());
        }
        // The last result of the summing will be a single block of data
        // containing the matrix A, the vector b and the error
        const data = new Float32Array(5 * 3 * stride);
        gl.readPixels(0, 0, 5, 3, gl.RGBA, gl.FLOAT, data);
        const [A, b, error] = constructEquation(data);

        // The algorithm has converged, because the error didn't change much
        // from the last loop. Note that the error might actually get higher
        // (and this is not a bad thing), because a better movement estimate may
        // match more points to each other. A very small error could simply mean
        // that there isn't much overlap between the point clouds.
        if (Math.abs(error - previousError) < ERROR_DIFF_THRESHOLD) {
            break;
        }
        // Solve Ax = b. The x vector will contain the 3 rotation angles (around
        // the x axis, y axis and z axis) and the translation (tx, ty, tz).
        const result = numeric.solve(A, b);
        // console.log("result: ", result);
        if (Number.isNaN(result[0])) {
            throw Error('No corresponding points between frames found.');
        }
        mat4.translate(
            movement, movement,
            vec3.fromValues(result[3], result[4], result[5]),
        );
        mat4.rotateX(movement, movement, result[0]);
        mat4.rotateY(movement, movement, result[1]);
        mat4.rotateZ(movement, movement, result[2]);
        previousError = error;
    }
    return movement;*/
}
