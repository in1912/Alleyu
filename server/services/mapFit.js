// 静态地图「装得下」计算：高德 staticmap 没有 auto-fit，固定 zoom 会把散开的点位裁掉
// （用户实测：北京封面图 zoom11 装不下长城—市区全程）。这里按点位包围盒反推 zoom 与中心。
// 纯函数、无依赖：guideService 与自检脚本都直接 require。
//
// Web 墨卡托：zoom z 时赤道处 256px 瓦片分辨率 ≈ 156543.03392 / 2^z 米/像素（scale=2 只加清不改视野）。
// 静态地图 size 的宽高即逻辑像素，能容纳包围盒（含 padding 余量）的最大整数 zoom 取宽高两方向的较小值。

const EQUATOR_RES = 156543.03392; // zoom0 时每像素米数（256px 瓦片）

function fitView(points, { width = 1000, height = 580, padding = 1.35, minZoom = 4, maxZoom = 16 } = {}) {
  const pts = (points || []).map((p) => {
    if (Array.isArray(p)) return { lng: p[0], lat: p[1] };
    if (p && p.lng != null && p.lat != null) return { lng: p.lng, lat: p.lat };
    return null;
  }).filter((p) => p && Number.isFinite(p.lng) && Number.isFinite(p.lat));
  if (!pts.length) return null;

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  const cLat = (minLat + maxLat) / 2;
  const cLng = (minLng + maxLng) / 2;

  const cosL = Math.cos((cLat * Math.PI) / 180);
  const mPerDegLng = 111320 * cosL;
  const mPerDegLat = 111320; // 中纬度纬向误差 <2%，padding 余量足够吃掉
  // 最小 500m 跨度：单点/聚堆时避免 zoom 顶到 maxZoom 反而看不见路网
  const spanLngM = Math.max((maxLng - minLng) * mPerDegLng, 500);
  const spanLatM = Math.max((maxLat - minLat) * mPerDegLat, 500);

  const zx = Math.log2((EQUATOR_RES * cosL * width) / (spanLngM * padding));
  const zy = Math.log2((EQUATOR_RES * cosL * height) / (spanLatM * padding)); // 正形投影：地面纵横米/像素同因子
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.floor(Math.min(zx, zy))));
  return { center: { lng: cLng, lat: cLat }, zoom };
}

module.exports = { fitView };
