import { createRouter, createWebHashHistory } from 'vue-router';
import { token } from '../api/index.js';
import { loadMe } from '../stores/session.js';

const routes = [
  { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
  { path: '/register', name: 'register', component: () => import('../views/RegisterView.vue') }, // v1.10.0 邀请码注册
  { path: '/account', name: 'account', component: () => import('../views/AccountView.vue') },   // v1.10.0 普通用户账号页
  { path: '/plan', name: 'plan', component: () => import('../views/PlanView.vue') },
  { path: '/history', name: 'history', component: () => import('../views/HistoryView.vue') },
  { path: '/guide/:id', name: 'guide', component: () => import('../views/GuideView.vue') },
  // v1.8.0 游记整理：列表 / 问答式新建 / 详情（进度+封面+导出）
  { path: '/journals', name: 'journals', component: () => import('../views/JournalsView.vue') },
  { path: '/journals/new', name: 'journal-new', component: () => import('../views/JournalWizardView.vue') },
  { path: '/journal/:id', name: 'journal', component: () => import('../views/JournalDetailView.vue') },
  // v1.10.0：城市景点库 / 设置（含用户管理与邀请码）都是管理员专属——服务端 canAccess 硬拒，这里管页面
  { path: '/library', name: 'library', component: () => import('../views/LibraryView.vue'), meta: { adminOnly: true } },
  { path: '/weather', name: 'weather', component: () => import('../views/WeatherView.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue'), meta: { adminOnly: true } },
  { path: '/users', name: 'users', component: () => import('../views/UsersView.vue'), meta: { adminOnly: true } },
  // v1.13.0 社区（公开，游客可看）与客服留言（游客可用）
  { path: '/community', name: 'community', component: () => import('../views/CommunityView.vue') },
  { path: '/community/:id', name: 'community-detail', component: () => import('../views/CommunityDetailView.vue') },
  { path: '/feedback', name: 'feedback', component: () => import('../views/FeedbackView.vue') },
  { path: '/s/:token', name: 'share', component: () => import('../views/ShareView.vue') }, // 公开分享页（免登录）
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({ history: createWebHashHistory(), routes });

// v1.8.0 起首页对游客开放（兔子场景就是门面）；未登录只能看首页/登录页/注册页/公开分享页。
// v1.10.0：这里还要问一次角色——adminOnly 的页面（景点库/设置/用户管理）非管理员直接回首页，
// 不留一个「打得开但满屏 403」的空壳。角色来自 stores/session.js 的共享缓存。
router.beforeEach(async (to) => {
  if (['login', 'share', 'home', 'register', 'community', 'community-detail', 'feedback'].includes(to.name)) return true;
  if (!token()) return { name: 'login' };
  const me = await loadMe();
  if (!me) return { name: 'login' };
  if (to.meta.adminOnly && me.role !== 'admin') return { name: 'home' };
  return true;
});

export default router;
