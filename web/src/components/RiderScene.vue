// 乳白兔子骑车场景：从 cy.html 移植（原版小猪，v1.1.0 按用户要求改成兔子），
// 只保留骑手+自行车+马路+树木+山丘。删掉：蓝天/星星/日月/云/天气粒子/车铃按钮/披风皇冠墨镜/路牌/Toast。
// 天空区域透明 → 页面背景直接透出；容器底缘 CSS 渐隐无框感。
// v1.10.1：**只把车架（含挡泥板，原本与车架同一个红）改成浅粉 #f472b6**（用户要求；首页/登录页/注册页
//          共用本组件，改一处三页都变）。车轮/链条/脚踏/牙盘/车把/车座/车铃/车灯/草编花篮一律保持原色，
//          兔子本体与小黄帽也没动。同版还按用户要求把兔子的两只眼睛改成一样大（后眼原为透视缩小版）。
//          ⚠️ 上一版曾把整车都刷成粉，用户明确否掉——「只改车架」就是只改车架。
// 对外暴露 jump()：首页输入框每敲一个字符触发一次【兔跳特技】。
<template>
  <div class="scene-box" ref="box">
    <svg :viewBox="viewBox" preserveAspectRatio="xMidYMax slice">
      <defs>
        <radialGradient id="furGrad" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stop-color="#fffdf7" />
          <stop offset="100%" stop-color="#efe7d6" />
        </radialGradient>
      </defs>

      <!-- 远景山丘（保留原色，顶部透出页面背景） -->
      <g id="farHillsLayer">
        <path d="M -100 350 Q 90 190 290 350 Q 480 210 680 350 Q 850 200 1000 350 Z" fill="#86efac" />
        <path d="M -50 350 Q 180 230 410 350 Q 620 220 860 350 Z" fill="#4ade80" opacity="0.85" />
      </g>

      <!-- 中景树木（JS 循环生成） -->
      <g id="sceneryTreesLayer"></g>

      <!-- 草地与马路 -->
      <g id="groundLayer">
        <rect x="0" y="342" width="800" height="108" fill="#22c55e" />
        <rect x="0" y="356" width="800" height="74" fill="#475569" />
        <line x1="0" y1="360" x2="800" y2="360" stroke="#cbd5e1" stroke-width="3" />
        <line x1="0" y1="426" x2="800" y2="426" stroke="#cbd5e1" stroke-width="3" />
        <line id="roadDashLine" x1="-100" y1="393" x2="900" y2="393" stroke="#fde047" stroke-width="5"
          stroke-dasharray="40 35" stroke-linecap="round" />
      </g>

      <ellipse id="bikeGroundShadow" cx="400" cy="400" rx="115" ry="12" fill="#0f172a" opacity="0.22" />

      <!-- 兔子 + 自行车整体 -->
      <g id="bikerRoot">
        <g id="bikerTiltGroup">
          <g id="exhaustParticles"></g>

          <g id="backLegGroup">
            <line id="leftThigh" x1="340" y1="250" x2="380" y2="290" stroke="#f3ecdd" stroke-width="20" stroke-linecap="round" />
            <line id="leftCalf" x1="380" y1="290" x2="400" y2="340" stroke="#ece2cf" stroke-width="15" stroke-linecap="round" />
            <ellipse id="leftHoof" cx="400" cy="340" rx="11" ry="6" fill="#fbf7ee" stroke="#b3a68c" stroke-width="2" />
          </g>

          <line id="leftCrankArm" x1="385" y1="340" x2="385" y2="310" stroke="#64748b" stroke-width="6" stroke-linecap="round" />
          <rect id="leftPedalPad" x="374" y="306" width="22" height="7" rx="3" fill="#1e293b" />

          <!-- v1.10.1：**只把车架（含挡泥板，原本和车架同一个红）改成浅粉**，其余整车保持原色：
               黑胎(#1e293b) + 白轮圈(#e2e8f0) + 灰辐条(#cbd5e1) + 灰链条(#475569) + 灰前叉/座管(#94a3b8)
               + 深灰车座(#334155) + 浅灰车把(#cbd5e1) + 黄车铃(#fbbf24) + 黄车灯(#fde047)
               + 草编花篮(#d97706/#92400e/#fef3c7) + 灰白牙盘(#e2e8f0/#64748b) + 灰曲柄脚踏(#94a3b8/#0f172a)。
               浅粉选 #f472b6：比原来的玫红(#f43f5e)浅一档，且是**在浅灰绿背景上还看得见的最浅一档**
               （再浅如 #f9a8d4 对比度只有约 1.02:1，等于画了看不见）。 -->
          <g id="rearWheel" transform="translate(305, 340)">
            <circle r="50" fill="none" stroke="#1e293b" stroke-width="11" />
            <circle r="43" fill="none" stroke="#e2e8f0" stroke-width="3.5" />
            <g id="rearSpokes" stroke="#cbd5e1" stroke-width="2">
              <line x1="-42" y1="0" x2="42" y2="0" />
              <line x1="0" y1="-42" x2="0" y2="42" />
              <line x1="-30" y1="-30" x2="30" y2="30" />
              <line x1="-30" y1="30" x2="30" y2="-30" />
              <circle cx="32" cy="0" r="4" fill="#ef4444" stroke="none" />
            </g>
            <circle r="9" fill="#475569" />
          </g>

          <g id="frontWheel" transform="translate(485, 340)">
            <circle r="50" fill="none" stroke="#1e293b" stroke-width="11" />
            <circle r="43" fill="none" stroke="#e2e8f0" stroke-width="3.5" />
            <g id="frontSpokes" stroke="#cbd5e1" stroke-width="2">
              <line x1="-42" y1="0" x2="42" y2="0" />
              <line x1="0" y1="-42" x2="0" y2="42" />
              <line x1="-30" y1="-30" x2="30" y2="30" />
              <line x1="-30" y1="30" x2="30" y2="-30" />
              <circle cx="32" cy="0" r="4" fill="#ef4444" stroke="none" />
            </g>
            <circle r="9" fill="#475569" />
          </g>

          <path d="M 305 331 L 385 325 L 385 355 L 305 349 Z" fill="none" stroke="#475569" stroke-width="3" stroke-dasharray="5 3" />

          <g id="bikeFrameGroup">
            <path d="M 250 328 A 56 56 0 0 1 350 302" fill="none" stroke="#f472b6" stroke-width="6" stroke-linecap="round" />
            <path d="M 442 304 A 56 56 0 0 1 536 320" fill="none" stroke="#f472b6" stroke-width="6" stroke-linecap="round" />
            <path d="M 305 340 L 385 340 L 342 260 Z" fill="none" stroke="#f472b6" stroke-width="9" stroke-linejoin="round" stroke-linecap="round" />
            <path d="M 385 340 L 456 264 L 348 268" fill="none" stroke="#f472b6" stroke-width="10" stroke-linejoin="round" stroke-linecap="round" />
            <line x1="485" y1="340" x2="446" y2="225" stroke="#94a3b8" stroke-width="7" stroke-linecap="round" />
            <line x1="485" y1="340" x2="456" y2="264" stroke="#f472b6" stroke-width="9" stroke-linecap="round" />
            <line x1="342" y1="260" x2="336" y2="244" stroke="#94a3b8" stroke-width="7" stroke-linecap="round" />
            <path d="M 314 242 Q 338 235 362 245 Q 345 256 318 250 Z" fill="#334155" />
            <path d="M 456 238 L 470 238 A 8 8 0 0 1 470 254 L 456 254 Z" fill="#fde047" stroke="#475569" stroke-width="2.5" />
            <path d="M 446 225 Q 438 215 422 222" fill="none" stroke="#cbd5e1" stroke-width="7" stroke-linecap="round" />
            <g id="bikeBellGroup" transform="translate(438, 212)">
              <path d="M -9 4 A 9 9 0 0 1 9 4 Z" fill="#fbbf24" stroke="#d97706" stroke-width="2" />
              <rect x="-3" y="4" width="6" height="4" fill="#475569" />
            </g>
            <g transform="translate(462, 240)">
              <path d="M 0 0 L 28 0 L 23 28 L 4 28 Z" fill="#d97706" stroke="#92400e" stroke-width="2" stroke-linejoin="round" />
              <line x1="3" y1="9" x2="26" y2="9" stroke="#fef3c7" stroke-width="2" stroke-dasharray="4 3" />
              <line x1="4" y1="18" x2="24" y2="18" stroke="#fef3c7" stroke-width="2" stroke-dasharray="4 3" />
              <circle cx="10" cy="-3" r="5" fill="#fff" />
              <circle cx="10" cy="-3" r="2.2" fill="#facc15" />
              <circle cx="20" cy="-5" r="6" fill="#fbcfe8" />
              <circle cx="20" cy="-5" r="2.5" fill="#f43f5e" />
            </g>
          </g>

          <!-- 手臂双层：深色衬底 + 乳白上层（浅色肢体在浅背景上必须有描边感） -->
          <path id="leftArmUnder" d="M 366 196 Q 402 222 422 222" fill="none" stroke="#b3a68c" stroke-width="19" stroke-linecap="round" />
          <path id="leftArmPath" d="M 366 196 Q 402 222 422 222" fill="none" stroke="#f6f1e5" stroke-width="14" stroke-linecap="round" />

          <g id="riderTorsoAndHead">
            <g id="rabbitTail" transform="translate(310, 224)">
              <circle cx="-4" cy="-8" r="11" fill="#fdfaf3" stroke="#c9bda6" stroke-width="2.5" />
              <path d="M -12 -12 Q -6 -16 -2 -11" fill="none" stroke="#e3d8c4" stroke-width="2" stroke-linecap="round" />
            </g>
            <ellipse cx="348" cy="212" rx="42" ry="37" transform="rotate(-14 348 212)" fill="url(#furGrad)" stroke="#b9ac93" stroke-width="2.5" />
            <path d="M 314 226 Q 348 218 378 232 A 40 35 0 0 1 314 226 Z" fill="#3b82f6" opacity="0.9" />
            <line x1="335" y1="224" x2="342" y2="185" stroke="#3b82f6" stroke-width="7" stroke-linecap="round" />
            <circle cx="337" cy="222" r="3.5" fill="#fde047" />

            <g id="rabbitBackEar" transform="translate(384, 122)">
              <path d="M 0 0 C 14 -24 18 -58 8 -78 C -4 -70 -8 -26 -2 -2 Z" fill="#ece3d0" stroke="#b9ac93" stroke-width="2.5" />
              <path d="M 1 -8 C 9 -26 11 -50 5 -64 C -2 -54 -4 -26 -1 -12 Z" fill="#f0d4dc" opacity="0.8" />
            </g>

            <g id="riderHeadGroup" transform="translate(366, 150)">
              <circle cx="0" cy="0" r="39" fill="url(#furGrad)" stroke="#b9ac93" stroke-width="2.5" />
              <!-- 腮红 -->
              <circle cx="28" cy="10" r="5" fill="#f8cdd7" opacity="0.8" />
              <circle cx="-4" cy="12" r="4" fill="#f8cdd7" opacity="0.6" />
              <!-- 兔鼻（小三角）+ W 形嘴 + 胡须 -->
              <path d="M 16 3 L 26 3 L 21 10 Z" fill="#ec8fa8" stroke="#ec8fa8" stroke-width="2" stroke-linejoin="round" />
              <path d="M 21 10 Q 17 16 12 12 M 21 10 Q 26 16 30 12" fill="none" stroke="#a8846f" stroke-width="2.5" stroke-linecap="round" />
              <g stroke="#c9bda6" stroke-width="1.5" stroke-linecap="round">
                <line x1="10" y1="4" x2="-6" y2="2" />
                <line x1="10" y1="9" x2="-6" y2="11" />
                <line x1="32" y1="3" x2="46" y2="1" />
                <line x1="32" y1="8" x2="46" y2="10" />
              </g>
              <!-- 两只眼（v1.6.2 加的后眼；v1.10.1 用户要求**两眼一样大**——后眼原来按透视画小一号(4.6)，
                   现在改成和前眼同尺寸同高光，只是整体左移 26 个单位。同组同 opacity，眨眼/笑眼自动联动） -->
              <g id="riderEyeOpen" transform="translate(16, -11)">
                <circle cx="0" cy="0" r="5.5" fill="#1e293b" />
                <circle cx="-1.8" cy="-2" r="2.2" fill="#ffffff" />
                <circle cx="-26" cy="0" r="5.5" fill="#1e293b" />
                <circle cx="-27.8" cy="-2" r="2.2" fill="#ffffff" />
              </g>
              <path id="riderEyeHappy" d="M 10 -11 Q 16 -19 22 -11 M -16 -11 Q -10 -18.5 -4 -11" fill="none" stroke="#1e293b" stroke-width="3.5" stroke-linecap="round" opacity="0" />
              <g id="rabbitFrontEar" transform="translate(-16, -26)">
                <path d="M 0 0 C -15 -24 -17 -56 -6 -72 C 7 -66 13 -26 8 -2 Z" fill="url(#furGrad)" stroke="#b9ac93" stroke-width="2.5" />
                <path d="M -3 -8 C -11 -26 -12 -50 -5 -62 C 3 -52 6 -26 3 -10 Z" fill="#f6c3cf" opacity="0.85" />
              </g>
              <g transform="translate(-4, -36)">
                <path d="M -24 6 A 24 20 0 0 1 24 6 Z" fill="#facc15" stroke="#ca8a04" stroke-width="2.5" />
                <path d="M -4 6 A 24 20 0 0 1 24 6 L 34 8 Q 36 12 24 11 L -24 9 Z" fill="#eab308" stroke="#ca8a04" stroke-width="2" />
                <line x1="0" y1="-14" x2="0" y2="-23" stroke="#64748b" stroke-width="3.5" />
                <ellipse id="hatPropellerBlade" cx="0" cy="-23" rx="22" ry="3.5" fill="#ef4444" />
                <circle cx="0" cy="-23" r="3.5" fill="#fde047" />
              </g>
            </g>
          </g>

          <g transform="translate(385, 340)">
            <circle r="17" fill="#e2e8f0" stroke="#64748b" stroke-width="4" />
            <circle r="6" fill="#475569" />
          </g>
          <line id="rightCrankArm" x1="385" y1="340" x2="385" y2="370" stroke="#94a3b8" stroke-width="6.5" stroke-linecap="round" />

          <g id="frontLegGroup">
            <line id="rightThigh" x1="340" y1="248" x2="375" y2="295" stroke="#f3ecdd" stroke-width="22" stroke-linecap="round" />
            <line id="rightCalf" x1="375" y1="295" x2="385" y2="370" stroke="#ece2cf" stroke-width="16" stroke-linecap="round" />
            <ellipse id="rightHoof" cx="385" cy="370" rx="12" ry="6.5" fill="#fbf7ee" stroke="#b3a68c" stroke-width="2" />
          </g>
          <rect id="rightPedalPad" x="374" y="366" width="22" height="7" rx="3" fill="#0f172a" />

          <path id="rightArmUnder" d="M 356 202 Q 396 232 426 223" fill="none" stroke="#b3a68c" stroke-width="20" stroke-linecap="round" />
          <path id="rightArmPath" d="M 356 202 Q 396 232 426 223" fill="none" stroke="#f6f1e5" stroke-width="15" stroke-linecap="round" />
          <circle cx="426" cy="223" r="7" fill="#ec8fa8" />
        </g>
      </g>

      <!-- 跳跃 ⭐ 粒子层 -->
      <g id="floatingEffectsLayer"></g>
    </svg>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';

const viewBox = '0 0 800 450';
const box = ref(null);

// ---- 音效（跳跃弹簧音；每键触发，音量调低避免轰炸） ----
const sfx = {
  ctx: null,
  playJump() {
    try {
      if (!sfx.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) sfx.ctx = new AC();
      }
      if (sfx.ctx && sfx.ctx.state === 'suspended') sfx.ctx.resume();
      if (!sfx.ctx) return;
      const now = sfx.ctx.currentTime;
      const osc = sfx.ctx.createOscillator();
      const gain = sfx.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(190, now);
      osc.frequency.exponentialRampToValueAtTime(620, now + 0.28);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.32);
      osc.connect(gain);
      gain.connect(sfx.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.33);
    } catch { /* 无声环境忽略 */ }
  },
};

const state = {
  targetSpeed: 40, currentSpeed: 40,
  pedalAngle: 0, wheelAngle: 0, roadDashOffset: 0,
  jumpY: 0, jumpVy: 0, isJumping: false,
  wheelieAngle: 0, wheelieTarget: 0,
  blinkTimer: 0, happyEyeTimer: 0,
};
const SVG_NS = 'http://www.w3.org/2000/svg';
let dom = {};
let sceneryItems = [];
let exhaustList = [];
let frameCount = 0;
let rafId = 0;
let disposed = false;

function initScenery() {
  const layer = dom.treesLayer;
  const itemConfigs = [
    { x: 60, type: 'tree', scale: 0.95 },
    { x: 190, type: 'bush', scale: 0.85 },
    { x: 330, type: 'pine', scale: 1.05 },
    { x: 470, type: 'bush', scale: 0.75 },
    { x: 610, type: 'tree', scale: 0.8 },
    { x: 760, type: 'bush', scale: 1.0 },
    { x: 890, type: 'pine', scale: 0.9 },
  ];
  for (const cfg of itemConfigs) {
    const g = document.createElementNS(SVG_NS, 'g');
    if (cfg.type === 'tree') {
      g.innerHTML = `
        <rect x="-7" y="-48" width="14" height="50" rx="4" fill="#92400e" />
        <circle cx="0" cy="-68" r="28" fill="#4ade80" />
        <circle cx="-16" cy="-55" r="20" fill="#22c55e" />
        <circle cx="16" cy="-55" r="20" fill="#16a34a" />
        <circle cx="-8" cy="-76" r="5" fill="#fb7185" />
        <circle cx="12" cy="-62" r="5" fill="#fb7185" />`;
    } else if (cfg.type === 'pine') {
      g.innerHTML = `
        <rect x="-6" y="-38" width="12" height="40" fill="#78350f" />
        <polygon points="0,-105 -30,-55 30,-55" fill="#15803d" />
        <polygon points="0,-82 -35,-32 35,-32" fill="#16a34a" />`;
    } else {
      g.innerHTML = `
        <circle cx="-12" cy="-12" r="14" fill="#22c55e" />
        <circle cx="12" cy="-10" r="12" fill="#16a34a" />
        <circle cx="0" cy="-18" r="16" fill="#4ade80" />
        <circle cx="-6" cy="-18" r="4" fill="#fef08a" />
        <circle cx="8" cy="-14" r="4" fill="#f472b6" />`;
    }
    layer.appendChild(g);
    sceneryItems.push({ el: g, x: cfg.x, scale: cfg.scale });
  }
}

// 双连杆逆运动学（cy.html 原版）
function solveKneeIK(hx, hy, fx, fy, L1, L2) {
  const dx = fx - hx;
  const dy = fy - hy;
  let dist = Math.hypot(dx, dy);
  const maxReach = L1 + L2 - 0.5;
  if (dist > maxReach) dist = maxReach;
  if (dist < Math.abs(L1 - L2) + 0.5) dist = Math.abs(L1 - L2) + 0.5;
  const baseAngle = Math.atan2(dy, dx);
  const cosAlpha = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist);
  const alpha = Math.acos(Math.max(-1, Math.min(1, cosAlpha)));
  const kneeAngle = baseAngle - alpha;
  return { kx: hx + L1 * Math.cos(kneeAngle), ky: hy + L1 * Math.sin(kneeAngle) };
}

function spawnFloatingSymbol(symbolText, x, y) {
  const textEl = document.createElementNS(SVG_NS, 'text');
  textEl.setAttribute('x', x + (Math.random() * 24 - 12));
  textEl.setAttribute('y', y);
  textEl.setAttribute('font-size', '24');
  textEl.setAttribute('class', 'float-particle');
  textEl.textContent = symbolText;
  dom.floatingLayer.appendChild(textEl);
  setTimeout(() => { if (textEl.parentNode) textEl.parentNode.removeChild(textEl); }, 1100);
}

function spawnExhaustPuff() {
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('r', '5');
  circle.setAttribute('fill', '#e2e8f0');
  circle.setAttribute('opacity', '0.7');
  dom.exhaustLayer.appendChild(circle);
  exhaustList.push({ el: circle, x: 255, y: 375 + (Math.random() * 10 - 5), vx: -2 - Math.random() * 2, vy: -0.6 - Math.random() * 0.8, r: 5, life: 1.0 });
}

function animateLoop() {
  if (disposed) return;
  frameCount++;
  state.currentSpeed += (state.targetSpeed - state.currentSpeed) * 0.08;
  const effectiveSpeed = state.currentSpeed;

  const angularStep = effectiveSpeed * 0.0032;
  state.pedalAngle += angularStep;
  state.wheelAngle = (state.wheelAngle + effectiveSpeed * 0.25) % 360;
  dom.rearWheel.setAttribute('transform', `translate(305, 340) rotate(${state.wheelAngle})`);
  dom.frontWheel.setAttribute('transform', `translate(485, 340) rotate(${state.wheelAngle})`);

  const crankCenter = { x: 385, y: 340 };
  const crankRadius = 26;
  const rPedalX = crankCenter.x + crankRadius * Math.cos(state.pedalAngle);
  const rPedalY = crankCenter.y + crankRadius * Math.sin(state.pedalAngle);
  dom.rightCrankArm.setAttribute('x2', rPedalX);
  dom.rightCrankArm.setAttribute('y2', rPedalY);
  dom.rightPedalPad.setAttribute('x', rPedalX - 11);
  dom.rightPedalPad.setAttribute('y', rPedalY - 3.5);
  const lPedalX = crankCenter.x + crankRadius * Math.cos(state.pedalAngle + Math.PI);
  const lPedalY = crankCenter.y + crankRadius * Math.sin(state.pedalAngle + Math.PI);
  dom.leftCrankArm.setAttribute('x2', lPedalX);
  dom.leftCrankArm.setAttribute('y2', lPedalY);
  dom.leftPedalPad.setAttribute('x', lPedalX - 11);
  dom.leftPedalPad.setAttribute('y', lPedalY - 3.5);

  const bodyBounceY = Math.sin(state.pedalAngle * 2) * (state.currentSpeed > 2 ? 3.2 : 0.8);
  const hipX = 342;
  const hipY = 238 + bodyBounceY;

  const rKnee = solveKneeIK(hipX, hipY, rPedalX, rPedalY, 54, 56);
  dom.rightThigh.setAttribute('x1', hipX); dom.rightThigh.setAttribute('y1', hipY);
  dom.rightThigh.setAttribute('x2', rKnee.kx); dom.rightThigh.setAttribute('y2', rKnee.ky);
  dom.rightCalf.setAttribute('x1', rKnee.kx); dom.rightCalf.setAttribute('y1', rKnee.ky);
  dom.rightCalf.setAttribute('x2', rPedalX); dom.rightCalf.setAttribute('y2', rPedalY);
  dom.rightHoof.setAttribute('cx', rPedalX + 3); dom.rightHoof.setAttribute('cy', rPedalY - 2);

  const lKnee = solveKneeIK(hipX + 4, hipY - 2, lPedalX, lPedalY, 54, 56);
  dom.leftThigh.setAttribute('x1', hipX + 4); dom.leftThigh.setAttribute('y1', hipY - 2);
  dom.leftThigh.setAttribute('x2', lKnee.kx); dom.leftThigh.setAttribute('y2', lKnee.ky);
  dom.leftCalf.setAttribute('x1', lKnee.kx); dom.leftCalf.setAttribute('y1', lKnee.ky);
  dom.leftCalf.setAttribute('x2', lPedalX); dom.leftCalf.setAttribute('y2', lPedalY);
  dom.leftHoof.setAttribute('cx', lPedalX + 3); dom.leftHoof.setAttribute('cy', lPedalY - 2);

  const headTilt = Math.sin(state.pedalAngle) * 2.2;
  dom.riderTorsoAndHead.setAttribute('transform', `translate(0, ${bodyBounceY}) rotate(${headTilt} 350 210)`);
  const windStrength = state.currentSpeed * 0.35;
  const earFlutter = Math.sin(frameCount * 0.22) * (3 + state.currentSpeed * 0.12);
  dom.rabbitFrontEar.setAttribute('transform', `translate(-16, -26) rotate(${-windStrength + earFlutter})`);
  dom.rabbitBackEar.setAttribute('transform', `translate(384, 122) rotate(${-windStrength * 0.8 - earFlutter})`);
  const tailWag = Math.sin(frameCount * 0.18) * (6 + state.currentSpeed * 0.15);
  dom.rabbitTail.setAttribute('transform', `translate(310, 224) rotate(${tailWag})`);
  const bladeWidth = Math.max(3, Math.abs(Math.cos(frameCount * (0.15 + state.currentSpeed * 0.008))) * 22);
  dom.hatPropellerBlade.setAttribute('rx', bladeWidth);

  // 跳跃物理（兔跳特技）+ 空中翘头
  if (state.isJumping) {
    state.jumpY += state.jumpVy;
    state.jumpVy += 0.62;
    if (state.jumpY >= 0) { state.jumpY = 0; state.jumpVy = 0; state.isJumping = false; }
  }
  state.wheelieTarget = state.isJumping ? state.jumpVy * 0.9 : 0;
  state.wheelieAngle += (state.wheelieTarget - state.wheelieAngle) * 0.14;
  dom.bikerRoot.setAttribute('transform', `translate(0, ${state.jumpY})`);
  dom.bikerTiltGroup.setAttribute('transform', `rotate(${state.wheelieAngle} 305 340)`);

  const shadowScale = Math.max(0.45, 1 + state.jumpY / 180);
  dom.bikeGroundShadow.setAttribute('rx', 115 * shadowScale);
  dom.bikeGroundShadow.setAttribute('opacity', 0.22 * shadowScale);

  // 视差滚动
  state.roadDashOffset = (state.roadDashOffset + effectiveSpeed * 0.18) % 75;
  dom.roadDashLine.setAttribute('stroke-dashoffset', state.roadDashOffset);
  for (const item of sceneryItems) {
    item.x -= effectiveSpeed * 0.11;
    if (item.x < -120) item.x = 920;
    if (item.x > 930) item.x = -110;
    item.el.setAttribute('transform', `translate(${item.x}, 352) scale(${item.scale})`);
  }

  // 尾尘
  if (state.currentSpeed > 45 && frameCount % 6 === 0 && !state.isJumping) spawnExhaustPuff();
  for (let i = exhaustList.length - 1; i >= 0; i--) {
    const p = exhaustList[i];
    p.x += p.vx; p.y += p.vy; p.r += 0.25; p.life -= 0.04;
    if (p.life <= 0) {
      if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
      exhaustList.splice(i, 1);
    } else {
      p.el.setAttribute('cx', p.x); p.el.setAttribute('cy', p.y);
      p.el.setAttribute('r', p.r); p.el.setAttribute('opacity', p.life * 0.6);
    }
  }

  // 眨眼 / 开心笑眼
  if (state.happyEyeTimer > 0) {
    state.happyEyeTimer--;
    dom.riderEyeOpen.setAttribute('opacity', '0');
    dom.riderEyeHappy.setAttribute('opacity', '1');
  } else {
    state.blinkTimer++;
    const isBlinking = (state.blinkTimer % 210) > 202;
    dom.riderEyeOpen.setAttribute('opacity', isBlinking ? '0' : '1');
    dom.riderEyeHappy.setAttribute('opacity', isBlinking ? '1' : '0');
  }

  rafId = requestAnimationFrame(animateLoop);
}

// 【兔跳特技】对外触发口
function jump() {
  if (!state.isJumping) {
    state.isJumping = true;
    state.jumpVy = -11.5;
    state.happyEyeTimer = 45;
    sfx.playJump();
    spawnFloatingSymbol('⭐', 385, 130);
  }
}

onMounted(() => {
  const root = box.value;
  const $ = (id) => root.querySelector('#' + id);
  dom = {
    treesLayer: $('sceneryTreesLayer'),
    floatingLayer: $('floatingEffectsLayer'),
    exhaustLayer: $('exhaustParticles'),
    rearWheel: $('rearWheel'), frontWheel: $('frontWheel'),
    rightCrankArm: $('rightCrankArm'), leftCrankArm: $('leftCrankArm'),
    rightPedalPad: $('rightPedalPad'), leftPedalPad: $('leftPedalPad'),
    rightThigh: $('rightThigh'), rightCalf: $('rightCalf'), rightHoof: $('rightHoof'),
    leftThigh: $('leftThigh'), leftCalf: $('leftCalf'), leftHoof: $('leftHoof'),
    riderTorsoAndHead: $('riderTorsoAndHead'), rabbitFrontEar: $('rabbitFrontEar'), rabbitBackEar: $('rabbitBackEar'),
    rabbitTail: $('rabbitTail'), hatPropellerBlade: $('hatPropellerBlade'),
    bikerRoot: $('bikerRoot'), bikerTiltGroup: $('bikerTiltGroup'),
    bikeGroundShadow: $('bikeGroundShadow'), roadDashLine: $('roadDashLine'),
    riderEyeOpen: $('riderEyeOpen'), riderEyeHappy: $('riderEyeHappy'),
  };
  initScenery();
  // 点击兔子也跳一下（顺手的小互动）
  root.addEventListener('click', jump);
  rafId = requestAnimationFrame(animateLoop);
});

onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(rafId);
});

defineExpose({ jump });
</script>
