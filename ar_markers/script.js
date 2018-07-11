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

function initGLForARMarkerDetection(gl, width, height, texture_unit_base = 0) {
  if (!gl.getExtension('EXT_color_buffer_float')) {
    console.error("EXT_color_buffer_float is required, abort.");
    return null;
  }

  const vertex_buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertex_buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0,1,0,1,1,0,1]), gl.STATIC_DRAW);

  const line_index_buffer= gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, line_index_buffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2,3]), gl.STATIC_DRAW);

  const index_buffer= gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index_buffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2,0,2,3]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

  const calculateEdgeCodeToGradientDirectionMap = () => {
    // Reconsider moving this offline and  const array in this file.
    const edges = new Float32Array(1024).fill(0);
    for (let i = 0; i < 256; ++i) {
      // b3 b2 b1
      // b4  0 b0
      // b5 b6 b7
      // bit bi (i E [0..7]) could be 1 or 0. Central pixel is '0' - black.
      // We are looking, when enumerating b0->b7, for sequence of 3 to 6
      // '0's. If there is such "arc" in "circle" around central pixel. 
      // then the central pixel as a part of edge.
      // |changes| is result of xor with circular 8-bit shift. We use it to
      // identify '0' and '1' sequences.
      let changes = i ^ ((i << 1) | (i >> 7));
      let start = -1;
      let end = -1;
      let j = 0;
      edges[4 * i + 3] = 1.0; // alpha
      for (; j < 8; j++) {
        if (changes & (1 << j)) {
          start = j;
          j++;
          break;
        }
      }
      for (; j < 8; j++) {
        if (changes & (1 << j)) {
          end = j;
          j++;
          break;
        }
      }
      for (; j < 8; j++) {
        if (changes & (1 << j)) {
          // more than one change means it is not an edge, sharp edge and
          // we are not interested in for this case.
          start = -1;
          end = -1;
          break;
        }
      }
      if (end == -1)
        continue; // this is not an edge, leave black.
      let width = end - start;
      if ((i & (1 << start)) != 0) {
        width = 8 - width;
        const tmp = start;
        start = end;
        end = tmp;
      }
      end = (end + 7) % 8; // previous one, wrap around 0.
      if (width < 3)
        continue; // not an edge.
      edges[4 * i] = ((end + ((start + 8 - end) % 8) / 2) % 8) / 8;
      edges[4 * i + 1] = start / 8;
      edges[4 * i + 2] = end / 8;
    }
    return edges;
  }

  // Start and end, calculated in calculateEdgeCodeToGradientDirectionMap,
  // are referred here as direction, need to be translated to vec2 offset of
  //  neighbor texture sample in given direction. Using this mapping, we can
  // efficiently enumerate values of connected edge pixels.
  const createDirectionToOffsetMapping = () => {
    const dx = 1.0 / width;
    const dy = -1.0 / height; // bottom to top in shader.
    return [
      dx, 0, dx, dy, 0, dy, -dx, dy,
      -dx, 0, -dx, -dy, 0, -dy, dx, -dy
    ];
  }

  // Sample around point so that first nearest points are sampled, then
  // those on distance 2, and so on.
  const createSamplingEnumerationOffsets = () => {
    const dx = 1.0 / width;
    const dy = -1.0 / height;
    return [
      dx, 0, dx, dy, 0, dy, -dx, dy, -dx, 0, -dx, -dy, 0, -dy, dx, -dy,
      2*dx, 0, 2*dx, dy, 2*dx, 2*dy, dx, 2*dy, 0, 2*dy, -dx, 2*dy, -2*dx, 2*dy,
      -2*dx, dy, -2*dx, 0, -2*dx, -dy, -2*dx, -2*dy, -dx, -2*dy, 0, -2*dy,
      dx, -2*dy, 2*dx, -2*dy, 2*dx, -dy,

    ];
  }

  const createProgram = (vs, ps, texture) => {
    // Shaders and program are needed only if rendering depth texture.
    var vertex_shader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertex_shader, vs);
    gl.compileShader(vertex_shader);

    var pixel_shader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(pixel_shader, ps);
    gl.compileShader(pixel_shader);

    var program  = gl.createProgram();
    gl.attachShader(program, vertex_shader);
    gl.attachShader(program, pixel_shader);
    gl.linkProgram(program);
    const vinfo = gl.getShaderInfoLog(vertex_shader);
    const pinfo = gl.getShaderInfoLog(pixel_shader);
    if (vinfo.length > 0)
      console.error(vinfo);
    if (pinfo.length > 0)
      console.error(pinfo);

    gl.useProgram(program);

    const vertex_location = gl.getAttribLocation(program, "v");
    gl.enableVertexAttribArray(vertex_location);
    program.vertex_location = vertex_location;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertex_buffer);
    gl.vertexAttribPointer(vertex_location, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1i(gl.getUniformLocation(program, "s"), texture.unit);
    gl.uniform2f(gl.getUniformLocation(program, "tex_dd"), 1.0 / width, 1.0 / height);
    return program;
  }

  const threshold_vertex = `#version 300 es
    precision mediump float;
    in vec2 v;
    out vec2 t;

    void main(){
      gl_Position = vec4(v.x * 2.0 - 1.0, v.y * 2.0 - 1.0, 0, 1);
      t = v;
    }`;
  const threshold_pixel = `#version 300 es
    precision mediump float;
    uniform sampler2D s;
    uniform vec2 tex_dd;
    uniform vec4 edges[256];
    in vec2 t;
    out vec4 fragColor;

    int white(vec4 s) {
      return (all(greaterThan(s.rgb, vec3(0.35)))
              && all(lessThan(abs(s.rgb - s.gbr).rgb, vec3(0.2))))
             ? 1 : 0; 
    }

    void main(){
      // 
      // s3 s2 s1 
      // s4 sc s0
      // s5 s6 s7
      int sc = white(texture(s, t));
      if (sc == 1) {
        fragColor = vec4(1.0);
        return;
      }
      int s0 = white(texture(s, t + vec2(tex_dd.x, 0.0)));
      int s1 = white(texture(s, t + vec2(tex_dd.x, -tex_dd.y)));
      int s2 = white(texture(s, t + vec2(0.0, -tex_dd.y)));
      int s3 = white(texture(s, t + vec2(-tex_dd.x, -tex_dd.y)));
      int s4 = white(texture(s, t - vec2(tex_dd.x, 0.0)));
      int s5 = white(texture(s, t + vec2(-tex_dd.x, tex_dd.y)));
      int s6 = white(texture(s, t + vec2(0.0, tex_dd.y)));
      int s7 = white(texture(s, t + vec2(tex_dd.x, tex_dd.y)));
       
      int u = s7 * 128 + s6 * 64 + s5 * 32 + s4 * 16 + s3 * 8 + s2 * 4 +
              s1 * 2 + s0;
      fragColor = edges[u];
    }`;

  const edges = calculateEdgeCodeToGradientDirectionMap();

  // Corners program identifies corners and pixels that are on straight line
  // - output fragColor .b and .a are offset to connected point in the
  // direction of start (when looking from the point that is processed to
  // the connected point, black pixels are on left side. 
  // fragColor.g (line_flag below) specifies if the line was
  // straight (when fragColor.r == 0, as for corner pixels .g has different
  // semantics).
  // When fragColor.r != 0, we have found a corner pixel and fragColor.r is
  // difference in direction of two edges on left and right.
  // White and black pixel values are passed unchanged.
  const corners_vertex = `#version 300 es
    precision mediump float;
    in vec2 v;
    out vec2 t;

    void main(){
      gl_Position = vec4(v.x * 2.0 - 1.0, v.y * 2.0 - 1.0, 0, 1);
      t = v;
    }`;
  const corners_pixel = `#version 300 es
    precision mediump float;
    uniform sampler2D s;
    in vec2 t;
    uniform vec2 tex_dd;
    uniform vec2 tex_size; // TODO textureSize
    out vec4 fragColor;
    uniform vec2 direction_offset[8];

    // Circular diff. |a|, |b| are angles E [0..1); 1 refers to 360 degrees.
    vec4 diff(vec4 a, vec4 b) {
      vec4 d = abs(a - b);
      return min(d, vec4(1.0) - d);
    }         

    // Circular mean. |a|, |b| are angles E [0..1); 1 refers to 360 degrees.
    vec4 avg(vec4 a, vec4 b) {
      vec4 d = mod(a - b + vec4(1.5), 1.0) - vec4(0.5);
      return mod(b + 0.5 * d + vec4(1.0), 1.0);
    }

    /*
    // mapped cosine is unique mapping of angle [0..2*PI] to [0..1] range. 
    float mapped_cosine(vec2 a) {
      float cosine = dot(a, vec2(1.0, 0.0)) / length(a);
      return 0.25 * ((a.y >= 0.0) ? (3.0 + cosine) : (1.0 - cosine));
    }*/

    void main(){
      vec4 tex = texture(s, t);
      // if r == 0, g is start, b is end. if both are 0, then it is not an
      // edge. If it is white, then again, g == b == 1.0.
      if (tex.g == tex.b) {
        fragColor = tex;
        return;  
      }
      // e.g. when sampling c0, using coded start and end we can enumerate
      // neighbor edge pixels.
      //          ...
      //  x x x x s2
      //  x x x s1
      //  x x c0
      //  x e1
      //  x x e2
      //  x x x e2
      //        ...
      // Start direction for c0 is s1, end direction for c0 is e1.
      // start direction is direction of the first black pixel (x or s or e
      // in the picture above) in continuous black arc, when evaluating
      // pixels around the selected pixel counterclockwise.

      // |ts1| texture coordinate of start1, 
      vec2 ts1 = t + direction_offset[int(tex.g * 8.0 + 0.5)];
      vec2 te1 = t + direction_offset[int(tex.b * 8.0 + 0.5)];
      vec4 s1 = texture(s, ts1);
      vec4 e1 = texture(s, te1);
      vec2 ts2 = ts1 + direction_offset[int(s1.g * 8.0 + 0.5)];
      vec2 te2 = te1 + direction_offset[int(e1.b * 8.0 + 0.5)];
      vec4 s2 = texture(s, ts2);
      vec4 e2 = texture(s, te2);
      vec2 ts3 = ts2 + direction_offset[int(s2.g * 8.0 + 0.5)];
      vec2 te3 = te2 + direction_offset[int(e2.b * 8.0 + 0.5)];
      vec4 s3 = texture(s, ts3);
      vec4 e3 = texture(s, te3);
      vec2 ts4 = ts3 + direction_offset[int(s3.g * 8.0 + 0.5)];
      vec2 te4 = te3 + direction_offset[int(e3.b * 8.0 + 0.5)];
      vec4 s4 = texture(s, ts4);
      vec4 e4 = texture(s, te4);
      vec2 ts5 = ts4 + direction_offset[int(s4.g * 8.0 + 0.5)];
      vec2 te5 = te4 + direction_offset[int(e4.b * 8.0 + 0.5)];
      vec4 s5 = texture(s, ts5);
      vec4 e5 = texture(s, te5);
      vec2 ts6 = ts5 + direction_offset[int(s5.g * 8.0 + 0.5)];
      vec2 te6 = te5 + direction_offset[int(e5.b * 8.0 + 0.5)];
      vec4 s6 = texture(s, ts6);
      vec4 e6 = texture(s, te6);
      vec2 ts7 = ts6 + direction_offset[int(s6.g * 8.0 + 0.5)];
      vec2 te7 = te6 + direction_offset[int(e6.b * 8.0 + 0.5)];
      vec4 s7 = texture(s, ts7);
      vec4 e7 = texture(s, te7);
      vec2 ts8 = ts7 + direction_offset[int(s7.g * 8.0 + 0.5)];
      vec2 te8 = te7 + direction_offset[int(e7.b * 8.0 + 0.5)];
      vec4 s8 = texture(s, ts8);
      vec4 e8 = texture(s, te8);

      if (s1.g == s1.b || s2.g == s2.b || s3.g == s3.b || s4.g == s4.b ||
          e1.g == e1.b || e2.g == e2.b || e3.g == e3.b || e4.g == e4.b ||
          s5.g == s5.b || s6.g == s6.b || s7.g == s7.b || s8.g == s8.b ||
          e5.g == e5.b || e6.g == e6.b || e7.g == e7.b || e8.g == e8.b) {
        // edge discontinued. abort.
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      // Mix directions of 4 consecutive elements; 1..4, 5..8.
      vec4 mix0 = avg(
          avg(vec4(s1.r, s5.r, e1.r, e5.r), vec4(s2.r, s6.r, e2.r, e6.r)),
          avg(vec4(s3.r, s7.r, e3.r, e7.r), vec4(s4.r, s8.r, e4.r, e8.r)));

      // check how much value changes in 8 elements left and right.
      // s[0..4] - e[0..4] -> f.r; s[5..8] - s[0..4] -> f.g;
      // e[0..4] - e[5..8] -> f.b; s[5..8] - e[5..8] -> f.a; 
      vec4 f = diff(mix0, mix0.brag);
      
      // line in direction of start     
      float line_flag = f.r < 0.1 ? (f.g < 0.1 ? 0.5 : 0.3) : 0.1;
      // normalize offset from [-8, 8] -> [0-10] -> [0.0..1.0]
      // if the line_flag
      vec2 offset_start = 0.0625 * tex_size *
          (8.0 * tex_dd + (line_flag == 0.5 ? ts8 : ts3) - t);

      // Use the furthest points on edges to calculate angle between edges.
      vec2 s_far = ts8 - t;
      vec2 e_far = te8 - t;

      // When not to consider for corner:
      if ((f.a < 0.15 && f.r < 0.094) || // near 180 degrees
          f.a > 0.85 || f.r > 0.85 || // angle near 0 degrees
          f.g + f.b > 0.105) { // lines not straight
        fragColor = vec4(0.0, line_flag, offset_start);
        return;
      }
      
      vec4 mixangle =
          avg(vec4(s1.g, e1.b, s3.g, e3.b), vec4(s2.g, e2.b, s4.g, e4.b));
      mixangle = avg(mixangle, mixangle.barg);
      // Disregard if the angle is reflex - interested in inner corners.
      if (mod(mixangle.r - mixangle.g + 1.0, 1.0) > 0.501) {
        fragColor = vec4(0.0, line_flag, offset_start);
        return;
      }

      // Length of s_far and e_far in pixels should be > 12.
      float minlength = tex_dd.x * 8.0;
      if (length(s_far) < minlength || length(e_far) < minlength) {
        fragColor = vec4(0.0, line_flag, offset_start);
        return;            
      }

      // Pass mix0.g and mix.a as information about edge directions.
      fragColor = vec4(mix(f.r, f.a, 0.5), f.g + f.b, offset_start);
    }`;

  const corners_refine_vertex = `#version 300 es
    precision mediump float;
    in vec2 v;
    out vec2 t;

    void main(){
      gl_Position = vec4(v.x * 2.0 - 1.0, v.y * 2.0 - 1.0, 0, 1);
      t = v;
    }`;
  const corners_refine_pixel = `#version 300 es
    precision mediump float;
    uniform sampler2D s;     
    in vec2 t;
    uniform vec2 tex_dd;
    uniform vec2 enumeration[24];
    out vec4 fragColor;

    bool isLocalCenter(vec4 tex) {
      for (int i = 0; i < 24; i++) {
        vec2 offset = enumeration[i];
        vec4 p = texture(s, t + offset);
        if (p.r > 0.99) // white pixels
          continue;
        if (p.r > tex.r)
          return false;
        else if (p.r == tex.r) {
          if (p.g < tex.g)
            return false;
          else if (p.g == tex.g) {
            if (offset.x < 0.0 || offset.x == 0.0 && offset.y < 0.0)
              return false;
          }
        }
      }
      return true;
    }

    void main() {
      vec4 tex = texture(s, t);
      if (tex.r > 0.01 && tex.r < 0.99) // corner and not white pixel
        fragColor = isLocalCenter(tex) ?
            vec4(0.9, tex.ba, 1.0) : vec4(tex.r, 0.3, tex.ba);
      else
        fragColor = tex;
    }`;

  const corners_by5_vertex = `#version 300 es
    precision mediump float;
    in vec2 v;
    out vec2 t;

    void main(){
      gl_Position = vec4(v.x * 2.0 - 1.0, v.y * 2.0 - 1.0, 0, 1);
      t = v;
    }`;
  const corners_by5_pixel = `#version 300 es
    precision mediump float;
    uniform sampler2D s;    
    in vec2 t;
    uniform vec2 tex_dd;
    out vec4 fragColor;

    void main() {
      // Framebuffer size is the same: map texture coordinates for rendering
      // to 5x smaller texture.
      vec2 bl = 5.0 * t - 2.0 * tex_dd;
      vec2 tr = 5.0 * t + 2.9 * tex_dd;
      for (vec2 row = bl; row.y < tr.y; row.y += tex_dd.y) {
        for (vec2 el = row; el.x < tr.x; el.x += tex_dd.x) {
          vec4 tex = texture(s, el);
          if (tex.r > 0.85 && tex.r < 0.95) {
            fragColor = vec4(
              el,    // position of the corner pixel
              tex.gb // offset to pixel on edge in start direction.
            );
            return;
          }
        }            
      }
      fragColor = vec4(0.0);
    }`;

  const edges_by5_vertex = `#version 300 es
    precision mediump float;
    in vec2 v;
    out vec2 t;

    void main(){
      gl_Position = vec4(v.x * 2.0 - 1.0, v.y * 2.0 - 1.0, 0, 1);
      t = v;
    }`;
  const edges_by5_pixel = `#version 300 es
    precision mediump float;
    uniform sampler2D s;
    uniform sampler2D full_s;        
    in vec2 t;
    uniform vec2 tex_dd;
    out vec4 fragColor;

    void main() {
      // x5 smaller than the framebuffer size: map texture coordinates for
      // sampling and rendering to 5x smaller texture.
      vec2 t5 = 5.0 * t;
      vec4 tex5 = texture(s, t5);
      vec4 zero = vec4(0.0);

      // see corners_by5_pixel for mapping calculation.
      if (tex5 == zero) {
        fragColor = zero;
        return;
      }

      // .rg is the position of the pixel in full image.
      vec4 pix5 = texture(full_s, tex5.rg);
      // pix5.r is 0.9, TODO: check. (corners_refine_pixel)

      // tex.ba is the same as pix.ba and is normalized offset.
      vec2 tnext = tex_dd * (16.0 * tex5.ba - 8.0) + tex5.rg;
      vec4 p = texture(full_s, tnext); // the next edge pixel's value.
      // TODO: p.g should be == line_flag (0.1-0.5)

      vec4 p5 = texture(s, tnext);

      int i = 0;
      float curve_length = 16.0 * tex_dd.x;
      for (i = 0; (p5.rg == tex5.rg || (p.g > 0.09 && p.g < 0.31)) && i < 4; i++) {
        tnext = tex_dd * (16.0 * p.ba - 8.0) + tnext;
        p = texture(full_s, tnext);
        p5 = texture(s, tnext);
        if (length(tex5.rg - tnext) > curve_length)
          break;
      }

      for (i = 0; p5 == zero && (p.g > 0.29 && p.g < 0.6) && i < 10; i++) {
        tnext = tex_dd * (16.0 * p.ba - 8.0) + tnext;
        p = texture(full_s, tnext);
        p5 = texture(s, tnext);
        if (p5 == zero && i > 1) {
          p5 = texture(s, tnext + (vec2(0.0, 5.0) * tex_dd));
          if (p5 != zero)
            break;
          p5 = texture(s, tnext - (vec2(0.0, 5.0) * tex_dd));
          if (p5 != zero)
            break;
          p5 = texture(s, tnext + (vec2(5.0, 0.0) * tex_dd));
          if (p5 != zero)
            break;
          p5 = texture(s, tnext - (vec2(5.0, 0.0) * tex_dd));
          if (p5 != zero)
            break;              
        }            
      }

      int prev = i;

      for (i = 0; p5 == zero && (p.g > 0.0 && p.g < 0.6) && i < 5; i++) {
        tnext = tex_dd * (16.0 * p.ba - 8.0) + tnext;
        p = texture(full_s, tnext);
        p5 = texture(s, tnext);

        if (p5 != zero)
          break;
        p5 = texture(s, tnext + (vec2(0.0, 5.0) * tex_dd));
        if (p5 != zero)
          break;
        p5 = texture(s, tnext - (vec2(0.0, 5.0) * tex_dd));
        if (p5 != zero)
          break;
        p5 = texture(s, tnext + (vec2(5.0, 0.0) * tex_dd));
        if (p5 != zero)
          break;
        p5 = texture(s, tnext - (vec2(5.0, 0.0) * tex_dd));
        if (p5 != zero)
          break;         
        p5 = texture(s, tnext + (vec2(5.0, 5.0) * tex_dd));
        if (p5 != zero)
          break;
        p5 = texture(s, tnext - (vec2(5.0, 5.0) * tex_dd));
        if (p5 != zero)
          break;
        p5 = texture(s, tnext + (vec2(5.0, -5.0) * tex_dd));
        if (p5 != zero)
          break;
        p5 = texture(s, tnext - (vec2(5.0, -5.0) * tex_dd));
        if (p5 != zero)
          break;         
      }

      fragColor = (p5.rg == tex5.rg) ? vec4(tex5.rg, 0.0, 0.0)
                                     : vec4(tex5.rg, p5.rg);
      // fragColor = (p5 == zero) ? vec4(tex5.rg, tnext.rg) : vec4(tex5.rg, 0.0, 0.0);

    }`;

  const squares_by40_vertex = `#version 300 es
    precision highp float;
    in vec2 v;
    out vec2 t;

    void main(){
      gl_Position = vec4(v.x * 2.0 - 1.0, v.y * 2.0 - 1.0, 0, 1);
      t = v;
    }`;
  const squares_by40_pixel = `#version 300 es
    precision highp float;
    uniform sampler2D s; 
    in vec2 t;
    uniform vec2 tex_dd;
    uniform sampler2D full_s;
    out vec4 fragColor;

    void main() {
      // scaling sampling coordinates for e.g. 640x480 viewport to sample 8x6
      // from 128x96 texture to wrote to 16x12 texture color bound to
      // framebuffer (viewport size 640x480).
      vec2 sample_scale = vec2(40.0, 30.0);
      vec2 sample_bounds = vec2(3.5, 2.5);
      vec2 bl = sample_scale * t - sample_bounds * tex_dd;
      vec2 tr = bl + 2.1 * sample_bounds * tex_dd;
      vec4 zero = vec4(0.0);
      for (vec2 row = bl; row.y < tr.y; row.y += tex_dd.y) {
        for (vec2 el = row; el.x < tr.x; el.x += tex_dd.x) {
          vec4 tex = texture(s, el);
          if (tex != zero) {
            // Follow connected points and in 4 hops we should be at the
            // same point.
            vec4 tex1 = texture(s, tex.ba);
            vec4 tex2 = texture(s, tex1.ba);
            vec4 tex3 = texture(s, tex2.ba);
            if (tex3 != zero && tex3.ba == tex.rg) {
              // now we have 4 connected edges. Detect AR Toolkit inner
              // points.
              vec2 t03_03 = mix(tex.rg, tex3.rg, 0.339);
              vec2 t12_03 = mix(tex1.rg, tex2.rg, 0.339);
              vec2 t03_07 = mix(tex.rg, tex3.rg, 0.66);
              vec2 t12_07 = mix(tex1.rg, tex2.rg, 0.66);
              // t_i0, ti_1 should be always black and t_i3 white.
              vec2 t_i0 = mix(t03_03, t12_03, 0.339);
              vec2 t_i1 = mix(t03_03, t12_03, 0.66);
              vec2 t_i3 = mix(t03_07, t12_07, 0.339);           

              if (texture(full_s, t_i0) != vec4(1.0) &&
                  texture(full_s, t_i1) != vec4(1.0) &&
                  texture(full_s, t_i3) == vec4(1.0)) {
                // this is Hamming code, let's get value encoded.
                vec2 t03_05 = mix(tex.rg, tex3.rg, 0.5);
                vec2 t12_05 = mix(tex1.rg, tex2.rg, 0.5);
                vec2 t_1 = mix(t03_05.rg, t12_05.rg, 0.339);
                vec2 t_2 = mix(t03_07.rg, t12_07.rg, 0.5);
                vec2 t_4 = mix(t03_05.rg, t12_05.rg, 0.5);
                vec2 t_8 = mix(t03_03.rg, t12_03.rg, 0.5);
                vec2 t_16 = mix(t03_07.rg, t12_07.rg, 0.66);
                vec2 t_32 = mix(t03_05.rg, t12_05.rg, 0.66);
                float code = (texture(full_s, t_1) != vec4(1.0) ? 1.0 : 0.0)
                    + (texture(full_s, t_2) != vec4(1.0) ? 2.0 : 0.0)
                    + (texture(full_s, t_4) != vec4(1.0) ? 4.0 : 0.0)
                    + (texture(full_s, t_8) != vec4(1.0) ? 8.0 : 0.0)
                    + (texture(full_s, t_16) != vec4(1.0) ? 16.0 : 0.0)
                    + (texture(full_s, t_32) != vec4(1.0) ? 32.0 : 0.0);
                fragColor = tex;
                vec2 size = vec2(textureSize(full_s, 0));
                fragColor.r += (code * 1024.0);
                // every fragColor float holds encoded information about
                // two square corners: integer part is for 3rd and 4th,
                // fractions (normalized [0-1)) for 1st and 2nd.
                // there should be no need to clamp 1st and second to 0.9999
                vec4 to_pixels = round(tex2 * vec4(size, size));
                fragColor += to_pixels;
                return;
              }
            }
          }
        }            
      }
      fragColor = vec4(0.0);
    }`;

  const simple_vertex = `
    attribute vec2 v;
    varying vec2 t;

    void main(){
      gl_Position = vec4(v.x * 2.0 - 1.0, -v.y * 2.0 + 1.0, 0, 1);
      t = v;
    }`;
  const simple_pixel = `
    precision mediump float;
    uniform sampler2D s;
    varying vec2 t;
    uniform vec2 tex_dd;

    void main(){
      vec4 tex = texture2D(s, t);
      gl_FragColor = tex;
    }`;

  const lineloop_vertex = `#version 300 es
    precision highp float;
    in vec2 v;
    uniform sampler2D s;
    uniform sampler2D edges;
    out vec4 color;

    void main(){
      //  Based on gl_InstanceID and gl_VertexID, sample detected square 
      // positions and compute the position on the screen.
      vec2 size = vec2(textureSize(s, 0));
      vec2 pos = vec2(mod(float(gl_InstanceID) + 0.5, size.x),
                      floor((float(gl_InstanceID) + 0.5) / size.x) + 0.5);
      pos /= size;
      
      vec4 tex0 = texture(s, pos);
      tex0 = fract(tex0); // marker code and other squares in decimal part.

      // Let's see which square vertex the shader is processing here...
      if (v.x == 0.0) {
        gl_Position = vec4(v.y == 0.0 ? tex0.rg : tex0.ba, 0.0, 1.0);
      } else { // == 1.0
        vec4 tex1 = texture(edges, tex0.ba);
        vec4 tex2 = texture(edges, tex1.ba);
        gl_Position = vec4(v.y == 0.0 ? tex2.ba : tex2.rg, 0.0, 1.0);
      }

      gl_Position = vec4(vec2(2.0, -2.0) * gl_Position.rg - vec2(1.0, -1.0), 0.0, 1.0);
      float d = 0.5 * (v.x + v.y);
      color = vec4(1.0 - d, abs(v.x - v.y), v.x * v.y, 1.0);
    }`;
  const lineloop_pixel = `#version 300 es
    precision highp float;
    in vec4 color;
    out vec4 fragColor;

    void main() {
      fragColor = color;
    }`;


  const codelabel_vertex = `#version 300 es
    precision highp float;
    in vec2 v;
    out vec3 t;
    uniform sampler2D s;
    out vec4 color;

    void main(){
      //  Based on gl_InstanceID and gl_VertexID, sample detected square 
      // positions and compute the position on the screen.
      vec2 size = vec2(textureSize(s, 0));
      vec2 pos = vec2(mod(float(gl_InstanceID) + 0.5, size.x),
                      floor((float(gl_InstanceID) + 0.5) / size.x) + 0.5);
      pos /= size;
      
      vec4 tex0 = texture(s, pos);
      if (tex0 == vec4(0.0)) {
        gl_Position = vec4(-2.0);
        return;
      }
      float code = floor(tex0.r / 1024.0);
      tex0 = fract(tex0); // marker code and other squares in decimal part.

      t = vec3(v, code);
      vec2 invy = vec2(0.06, -0.08) * v - vec2(code < 10.0 ? 0.045 : 0.03, 0.0);
      gl_Position = vec4(vec2(2.0, -2.0) * tex0.rg - vec2(1.0, -1.0) + invy, 0.0, 1.0);
    }`;
  const codelabel_pixel = `#version 300 es
    precision highp float;
    out vec4 fragColor;
    in vec3 t;
    uniform sampler2D code_atlas;

    void main() {
      // calculate atlas sampling rectangle
      vec2 pos = (vec2(mod(t.z, 8.0), floor((t.z + 0.5) / 8.0)) + t.xy) * vec2(0.125);
      fragColor = texture(code_atlas, pos);
    }`;


  let texture_unit = texture_unit_base;
  const createTexture = (allocate = true) => {
    gl.activeTexture(gl[`TEXTURE${texture_unit}`]);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    texture.unit = texture_unit++;
    if (allocate)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    return texture; 
  }

  const createFloatTexture = (w, h) => {
    gl.activeTexture(gl[`TEXTURE${texture_unit}`]);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    texture.unit = texture_unit++;
    texture.w = w;
    texture.h = h;
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
    return texture; 
  }      

  const createFramebuffer2D = (textureList) => {
    const framebuffer = gl.createFramebuffer();
    const drawBuffers = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    for (let i = 0; i < textureList.length; i += 1) {
      const texture = textureList[i];
      drawBuffers.push(gl[`COLOR_ATTACHMENT${i}`]);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl[`COLOR_ATTACHMENT${i}`],
        gl.TEXTURE_2D,
        texture,
        0, // mip-map level
      );
    }
    gl.drawBuffers(drawBuffers);
    return framebuffer;
  }

  const texture = createTexture(false);
  const threshold_texture = createTexture();
  const corners_texture = createTexture();
  const corners_refine_texture = createTexture();
  // Numbers valid for 640x480 and 960x540.
  const corners_by5_texture = createFloatTexture(width / 5, height / 5);
  const edges_by5_texture = createFloatTexture(width / 5, height / 5);
  const squares_by40_texture = createFloatTexture(width / 40, height / 30);

  gl.vao_markers = gl.createVertexArray();
  gl.bindVertexArray(gl.vao_markers);

  gl.passes = [{
    in: texture,
    framebuffer: createFramebuffer2D([threshold_texture]),
    program: createProgram(threshold_vertex, threshold_pixel, texture)
  }, {
    in: threshold_texture,
    framebuffer: createFramebuffer2D([corners_texture]),
    program: createProgram(corners_vertex, corners_pixel, threshold_texture)
  }, {
    in: corners_texture,
    framebuffer: createFramebuffer2D([corners_refine_texture]),
    program: createProgram(corners_refine_vertex, corners_refine_pixel,
                           corners_texture)
  }, {
    in: corners_refine_texture,
    out: [corners_by5_texture],
    framebuffer: createFramebuffer2D([corners_by5_texture]),
    program: createProgram(corners_by5_vertex, corners_by5_pixel,
                           corners_refine_texture)
  }, {
    in: corners_by5_texture,
    out: [edges_by5_texture],
    framebuffer: createFramebuffer2D([edges_by5_texture]),
    program: createProgram(edges_by5_vertex, edges_by5_pixel,
                           corners_by5_texture)
  }, {
    in: edges_by5_texture,
    out: [squares_by40_texture],
    framebuffer: createFramebuffer2D([squares_by40_texture]),
    program: createProgram(squares_by40_vertex, squares_by40_pixel,
                           edges_by5_texture)
  }, {
    in: texture,
    framebuffer: null,
    program: createProgram(simple_vertex, simple_pixel, texture)
  }, {
    in: squares_by40_texture,
    framebuffer: null,
    outlines: (width / 40) * (height / 30), // how many squares to draw.
    program: createProgram(lineloop_vertex, lineloop_pixel, squares_by40_texture)
  }, {
    in: squares_by40_texture,
    framebuffer: null,
    codes: (width / 40) * (height / 30), // how many codes to draw.
    program: createProgram(codelabel_vertex, codelabel_pixel, squares_by40_texture)
  }];

  const points_program = gl.passes[0].program;
  gl.useProgram(points_program);
  gl.uniform4fv(gl.getUniformLocation(points_program, "edges"), edges);
  const corner_program = gl.passes[1].program;
  gl.useProgram(corner_program);
  gl.uniform2fv(gl.getUniformLocation(corner_program, "direction_offset"),
                createDirectionToOffsetMapping());
  gl.uniform2fv(gl.getUniformLocation(corner_program, "tex_dd_inv"),
                createDirectionToOffsetMapping());
  gl.uniform2f(gl.getUniformLocation(corner_program, "tex_size"),
               width, height);
  const refine_program = gl.passes[2].program;
  gl.useProgram(refine_program);
  gl.uniform2fv(gl.getUniformLocation(refine_program, "enumeration"),
                createSamplingEnumerationOffsets());
  const edge_program = gl.passes[4].program;
  gl.useProgram(edge_program);
  gl.uniform1i(gl.getUniformLocation(edge_program, "full_s"),
               corners_texture.unit);
  const squares_program = gl.passes[5].program;
  gl.useProgram(squares_program);
  gl.uniform2f(gl.getUniformLocation(squares_program, "tex_dd"),
                                     5.0 / width, 5.0 / height);
  gl.uniform1i(gl.getUniformLocation(squares_program, "full_s"),
               corners_texture.unit);
  const render_squares_program = gl.passes[7].program;
  gl.useProgram(render_squares_program);
  gl.uniform1i(gl.getUniformLocation(render_squares_program, "edges"),
               edges_by5_texture.unit);
  const render_numbers_program = gl.passes[8].program;
  gl.useProgram(render_numbers_program);
  gl.uniform1i(gl.getUniformLocation(render_numbers_program, "code_atlas"),
               0);

  gl.vertex_buffer = vertex_buffer;
  gl.index_buffer = index_buffer;
  gl.line_index_buffer = line_index_buffer;
  gl.video_texture = texture;

  
  // Texture used for displaying detected codes 0..63
  const image = new Image();
  gl.codes_texture = gl.createTexture();
  image.onload = function() {
/*    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gl.codes_texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);*/
  };
  image.src = "64.png";
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.timer_extension = gl.getExtension("EXT_disjoint_timer_query_webgl2") || gl.getExtension("EXT_disjoint_timer_query");
  if (gl.timer_extension)
    gl.timer_query = gl.createQuery();

  return gl;
}