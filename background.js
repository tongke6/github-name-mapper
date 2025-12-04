// GitHub Name Mapper - Background Service Worker

const ALARM_NAME = 'daily-update';
const DEFAULT_CONFIG = {
  enabled: true,
  autoUpdate: true,
  jsonUrl: '',
  lastUpdate: null,
  developers: [],
  localRules: []
};

// 初始化
chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  if (!config.jsonUrl) {
    await saveConfig(DEFAULT_CONFIG);
  }
  
  // 设置每日更新定时器
  if (config.autoUpdate) {
    setupDailyAlarm();
  }
});

// 定时器触发
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    const config = await getConfig();
    if (config.autoUpdate && config.jsonUrl) {
      await fetchAndUpdateData(config.jsonUrl);
    }
  }
});

// 监听来自 popup 或 options 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender, sendResponse);
  return true; // 保持消息通道开放
});

async function handleMessage(request, sender, sendResponse) {
  try {
    switch (request.action) {
      case 'getConfig':
        const config = await getConfig();
        sendResponse({ success: true, data: config });
        break;
        
      case 'saveConfig':
        await saveConfig(request.config);
        // 更新定时器设置
        if (request.config.autoUpdate) {
          setupDailyAlarm();
        } else {
          chrome.alarms.clear(ALARM_NAME);
        }
        sendResponse({ success: true });
        break;
        
      case 'fetchData':
        const result = await fetchAndUpdateData(request.url);
        sendResponse(result);
        break;
        
      case 'getDevelopers':
        const devConfig = await getConfig();
        // 合并远程数据和本地规则
        const allDevelopers = [...devConfig.developers, ...devConfig.localRules];
        sendResponse({ success: true, data: allDevelopers });
        break;
        
      case 'addLocalRule':
        await addLocalRule(request.rule);
        sendResponse({ success: true });
        break;
        
      case 'removeLocalRule':
        await removeLocalRule(request.index);
        sendResponse({ success: true });
        break;
        
      case 'updateLocalRule':
        await updateLocalRule(request.index, request.rule);
        sendResponse({ success: true });
        break;
        
      case 'toggle':
        const currentConfig = await getConfig();
        currentConfig.enabled = request.enabled;
        await saveConfig(currentConfig);
        sendResponse({ success: true });
        break;
        
      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  } catch (error) {
    console.error('Message handling error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// 获取配置
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get('config', (result) => {
      resolve(result.config || DEFAULT_CONFIG);
    });
  });
}

// 保存配置
async function saveConfig(config) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ config }, resolve);
  });
}

// 设置每日定时器
function setupDailyAlarm() {
  // 每24小时触发一次
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: 24 * 60
  });
}

// 获取远程数据并更新
async function fetchAndUpdateData(url) {
  if (!url) {
    return { success: false, error: '请先配置 JSON URL' };
  }
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // 支持新格式: { data: { list: [...] } } 和旧格式: { developers: [...] }
    let rawDevelopers;
    if (data.data && Array.isArray(data.data.list)) {
      rawDevelopers = data.data.list;
    } else {
      throw new Error('JSON 格式错误: 缺少 data.list 数组');
    }
    
    // 转换并验证数据格式
    const validDevelopers = rawDevelopers
      .map(dev => ({
        // 新格式字段映射: account -> github_name, nickname -> nick, email -> github_acc
        github_name: dev.account || dev.github_name,
        nick: dev.nickname || dev.nick,
        domain: dev.domain,
        github_acc: dev.email || dev.github_acc
      }))
      .filter(dev => dev.github_name && (dev.nick || dev.domain));
    
    const config = await getConfig();
    config.developers = validDevelopers;
    config.lastUpdate = new Date().toISOString();
    await saveConfig(config);
    
    // 通知所有 GitHub 标签页更新
    notifyTabs();
    
    return { 
      success: true, 
      count: validDevelopers.length,
      lastUpdate: config.lastUpdate 
    };
  } catch (error) {
    console.error('Fetch error:', error);
    return { success: false, error: error.message };
  }
}

// 添加本地规则
async function addLocalRule(rule) {
  const config = await getConfig();
  config.localRules.push({
    ...rule,
    isLocal: true,
    createdAt: new Date().toISOString()
  });
  await saveConfig(config);
  notifyTabs();
}

// 删除本地规则
async function removeLocalRule(index) {
  const config = await getConfig();
  config.localRules.splice(index, 1);
  await saveConfig(config);
  notifyTabs();
}

// 更新本地规则
async function updateLocalRule(index, rule) {
  const config = await getConfig();
  config.localRules[index] = {
    ...config.localRules[index],
    ...rule,
    updatedAt: new Date().toISOString()
  };
  await saveConfig(config);
  notifyTabs();
}

// 通知所有 GitHub 标签页更新
function notifyTabs() {
  chrome.tabs.query({ url: ['https://github.com/*', 'https://*.github.com/*'] }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'refresh' }).catch(() => {
        // 忽略无法连接的标签页
      });
    });
  });
}

