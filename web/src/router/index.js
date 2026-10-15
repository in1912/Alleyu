import { createRouter, createWebHashHistory } from 'vue-router';
import { token } from '../api/index.js';

const routes = [
  { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
  { path: '/plan', name: 'plan', component: () => import('../views/PlanView.vue') },
  { path: '/history', name: 'history', component: () => import('../views/HistoryView.vue') },
  { path: '/guide/:id', name: 'guide', component: () => import('../views/GuideView.vue') },
  // v1.8.0 游记整理：列表 / 问答式新建 / 详情（进度+封面+导出）
  { path: '/journals', name: 'journals', component: () => import('../views/JournalsView.vue') },
  { path: '/journals/new', name: 'journal-new', component: () => import('../views/JournalWizardView.vue') },
  { path: '/journal/:id', name: 'journal', component: () => import('../views/JournalDetailView.vue') },
  { path: '/library', name: 'library', component: () => import('../views/LibraryView.vue') },
  { path: '/weather', name: 'weather', component: () => import('../views/WeatherView.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
  { path: '/users', name: 'users', component: () => import('../views/UsersView.vue') },
  { path: '/s/:token', name: 'share', component: () => import('../views/ShareView.vue') }, // 公开分享页（免登录）
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({ history: createWebHashHistory(), routes });

// v1.8.0 起首页对游客开放（兔子场景就是门面）；未登录只能看首页/登录页/公开分享页，
// 其余（生成攻略/游记/库/天气/设置）一律回登录页——游客点功能时由页面引导登录。
router.beforeEach((to) => {
  if (!['login', 'share', 'home'].includes(to.name) && !token()) return { name: 'login' };
  return true;
});

export default router;
