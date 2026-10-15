// 莫兰迪配色（v1.8.0 游记 PNG/PDF 共用）。值必须与服务端 pdfService.PALETTES 保持一致——
// PNG 在浏览器 canvas 画、PDF 在服务端 pdfkit 画，两处各存一份常量（服务端不能 require 前端模块）。
export const PALETTES = [
  { name: '雾灰绿', bg: '#E8E6DF', text: '#3D4038', sub: '#7A8073', acc: '#5A6650' },
  { name: '豆沙粉', bg: '#EFE6E4', text: '#4A3F3D', sub: '#9A8783', acc: '#A5645C' },
  { name: '灰蓝', bg: '#E3E8EB', text: '#37424C', sub: '#7C8A96', acc: '#6E8CA0' },
  { name: '暖沙', bg: '#EDE4D6', text: '#4A4234', sub: '#94886F', acc: '#A98D5F' },
  { name: '燕麦紫', bg: '#E9E5EC', text: '#3F3A45', sub: '#8B8494', acc: '#8B7F96' },
];
