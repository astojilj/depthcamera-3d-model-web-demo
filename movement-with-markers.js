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
let focalLengthX;
let focalLengthY;
let offsetX;
let offsetY;
let initialTransform = null;
const transform = mat4.create();
const q = quat.create();
const v = vec3.create();

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
  var matrix = mat3.create();

  for (let j = 0; j < h; j++) {
    const row = j * w * 4;
    const rend = (j + 1) * w * 4;
    for (let i = row; i < rend; i+=12) {
      if (readBuffer[i] != 0.0 && readBuffer[i+1] != 0.0) {
        // Calculate the pixel.
        let z = readBuffer[i + 2] % 8;
        let xf = readBuffer[i] / z;
        let yf = readBuffer[i + 1] / z;
        let x1 = xf * focalLengthX + offsetX;
        let y1 = yf * focalLengthY + offsetY;
        ctx2d.beginPath();
        ctx2d.fillStyle = "#FF0000";
        ctx2d.fillRect(x1, y1, 4, 4);
        ctx2d.stroke();


/*
        let xf = readBuffer[i] % 1.0;
        let yf = readBuffer[i+1] % 1.0;
        let x = ((xf * width) | 0) + 3;
        let y = ((yf * height) | 0) + 3;

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
*/        
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
  // We use three consecutive RGBA32F pixels in texture to hold information
  // about markers' 3D transform. 
  const t = gl.passes[5].out[0];
  const transformsTexture = ARMarker.createFloatTexture(gl, t.w * 3, t.h);
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
    uniform sampler2D sPos;
    uniform vec2 dd;
    in vec2 t;
    out vec4 fragColor;

    vec3 getColorPixelPosition(vec2 uv) {
      vec3 pos0 = texture(sPos, uv).xyz;
      // Y sign doesn't matter as the sampling is simetric.
      vec3 postl = texture(sPos, uv - vec2(dd.x, dd.y)).xyz;
      vec3 posbr = texture(sPos, uv + vec2(dd.x, dd.y)).xyz;
      vec3 postr = texture(sPos, uv - vec2(-dd.x, dd.y)).xyz;
      vec3 posbl = texture(sPos, uv + vec2(-dd.x, dd.y)).xyz;
      vec3 post = texture(sPos, uv - vec2(0.0, dd.y)).xyz;
      vec3 posb = texture(sPos, uv + vec2(0.0, dd.y)).xyz;
      vec3 posl = texture(sPos, uv - vec2(dd.x, 0.0)).xyz;
      vec3 posr = texture(sPos, uv + vec2(dd.x, 0.0)).xyz;
      vec3 pos1 = sign(postl.z * posbr.z) * mix(postl.z, posbr.z, 0.5);

      vec4 nonzero = sign(vec4(pos0.z, pos1.z, pos2.z, pos3.z));
      float count = dot(nonzero, nonzero);
      if (pos0.z == 0.0 || count < 3.0) // Let's continue with at least two samples.
        return vec3(0.0);
      vec3 d1 = pos1 - pos0;
      vec3 d2 = pos2 - pos0;
      vec3 d3 = pos3 - pos0;
      float dist1 = dot(d1, d1) * nonzero.y;
      float dist2 = dot(d2, d2) * nonzero.z;
      float dist3 = dot(d3, d3) * nonzero.w;
      if (dist1 > 0.00003 || dist2 > 0.00003 || dist3 > 0.00003)
        return vec3(0.0);
      // Mix only non zero values
      return (pos0 + pos1 * nonzero.y + pos2 * nonzero.z + pos3 * nonzero.w) / count;
    }

    void main() {
      // Viewport is 640x480, we are writing to 48x16 texture and
      // reading from 16*16.
      vec2 ts = vec2(13.3333333333, 30.0) * t;
      float tripplet = mod(ts.x, 0.0625);
      ts.x = ts.x + 0.03125 - tripplet; // to sample at cell center

      vec4 ar = texture(s, ts);
      if (ar.x == 0.0 && ar.y == 0.0) {
        fragColor = vec4(0.0);
        return;
      }
      vec4 t01 = fract(ar); // 1st and 2nd corner encoded in fracts.
      // Unpack the position of all the corners and get 3D positions.
      vec2 size = vec2(textureSize(sPos, 0)); // color texture size
      float code = trunc(ar.r/1024.0);
      vec4 t23 = trunc(ar - vec4(1024.0 * code, 0.0, 0.0, 0.0)) / vec4(size, size);
      vec3 p0 = getColorPixelPosition(t01.rg);
      vec3 p1 = getColorPixelPosition(t01.ba);
      vec3 p3 = getColorPixelPosition(t23.ba);
      vec3 p2 = getColorPixelPosition(t23.rg);
      // TODO: for p0, p1, p3, sample around and get average, even if zero.
      if (p0.z * p1.z * p3.z == 0.0) {
        // For start, ignore if any is zero.
        fragColor = vec4(0.0);
        return;
      }
      // now we have three points.
      // TODO: verify the distance.

      vec3 x = p3 - p0;
      vec3 y = p1 - p0;
      vec3 z = cross(x, y);
      float dotcheck = abs(dot(normalize(x),normalize(y))); 
      if (dotcheck > 0.06) {
        // Should be orthogonal.
        fragColor = vec4(0.0);
        return;
      }
      // y = cross(z, x); // fix if not orthogonal.

      z = p2;
      x = p1;
      y = p3;
      if (tripplet < 0.0208) {
        // z is always positive. less than 8m. Use it to encode the code.
        p0.z += (code * 8.0);
        fragColor = vec4(p0, x.x);            
      } else if (tripplet < 0.0416) {
        fragColor = vec4(x.yz, y.xy);
      } else {
        fragColor = vec4(y.z, z);
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
  gl.uniform1i(gl.getUniformLocation(p, "sPos"), d2cTexture.unit);
  gl.uniform2f(gl.getUniformLocation(d2c, 'dd'), 1 / color.w, 1 / color.h);

  gl.passes.splice(6, 3, d2cPass, transformCalculationPass);

  offsetX = cameraParams.colorOffset[0];
  offsetY = cameraParams.colorOffset[1];
  focalLengthX = cameraParams.colorFocalLength[0];
  focalLengthY = cameraParams.colorFocalLength[1];
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
  const pass = gl.passes[7];
  gl.bindFramebuffer(gl.FRAMEBUFFER, pass.framebuffer);
  _readFloatPixels(gl, pass.out[0].w, pass.out[0].h);

  if (READ_FLOAT_PIXELS) {
    // Put read and processed pixels to 2D canvas.
    // Note: This is just one of scenarios for the demo. You can directly
    // bind video to 2D canvas without using WebGL as intermediate step.
    // _putReadPixelsTo2DCanvas();
    _putReadFloatPixelsTo2DCanvas(pass.out[0].w, pass.out[0].h);
  }
  gl.bindVertexArray(null);

  // Calculate the transform. The first measured transformation we take as
  // the initial and then calculate transform from it.
  for (let i = 0; i < readBuffer.length; i+=12) {
    if (readBuffer[i] != 0.0 && readBuffer[i+1] != 0.0) {
      // For start, using marker 1.
      if (((readBuffer[i + 2] / 8) | 0) != 1)
        continue;

      q[0] = readBuffer[i + 4];
      q[1] = readBuffer[i + 5];
      q[2] = readBuffer[i + 6];
      q[3] = readBuffer[i + 7];
      v[0] = readBuffer[i];
      v[1] = readBuffer[i + 1];
      v[2] = readBuffer[i + 2];      

      if (!initialTransform) {
        initialTransform = mat4.create();
        initialTransform[0] = readBuffer[i + 3];
        initialTransform[1] = readBuffer[i + 4];
        initialTransform[2] = readBuffer[i + 5];
        initialTransform[4] = readBuffer[i + 6];
        initialTransform[5] = readBuffer[i + 7];
        initialTransform[6] = readBuffer[i + 8];
        initialTransform[8] = readBuffer[i + 9];
        initialTransform[9] = readBuffer[i + 10];
        initialTransform[10] = readBuffer[i + 11];
        initialTransform[12] = readBuffer[i];
        initialTransform[13] = readBuffer[i + 1];
        initialTransform[14] = readBuffer[i + 2] % 8;
        return mat4.create();  
      }
      // calculate transformation from initialTransform -> current transform
      transform[0] = readBuffer[i + 3];
      transform[1] = readBuffer[i + 4];
      transform[2] = readBuffer[i + 5];
      transform[4] = readBuffer[i + 6];
      transform[5] = readBuffer[i + 7];
      transform[6] = readBuffer[i + 8];
      transform[8] = readBuffer[i + 9];
      transform[9] = readBuffer[i + 10];
      transform[10] = readBuffer[i + 11];
      transform[12] = readBuffer[i];
      transform[13] = readBuffer[i + 1];
      transform[14] = readBuffer[i + 2] % 8;
      transform[3] = 0;
      transform[7] = 0;
      transform[11] = 0;
      transform[15] = 1;

      mat4.invert(transform, transform);
      mat4.mul(transform, transform, initialTransform);
      return transform;
    }
  }

  return null;
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
