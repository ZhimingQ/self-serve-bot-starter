/** Audience profiles share the same storefront, account and chat engine.
 * All examples are synthetic. A profile never enables tools or changes access. */
export const CUSTOMER_PRESET_IDS = ['general', 'creator', 'office', 'builder', 'study', 'business'] as const;
export type CustomerPresetId = (typeof CUSTOMER_PRESET_IDS)[number];
export interface CustomerPresetCopy {
  name: string;
  description: string;
  heroTitle: string;
  heroBody: string;
  greeting: string;
  prompts: readonly string[];
  workflows: readonly { kicker: string; title: string; prompt: string; result: string }[];
  example: { user: string; assistant: string; resultTitle: string; result1: string; result2: string };
}
export interface CustomerPreset {
  id: CustomerPresetId;
  accent: string;
  instructions: string;
  en: CustomerPresetCopy;
  zh: CustomerPresetCopy;
}

export function isCustomerPresetId(value: unknown): value is CustomerPresetId {
  return typeof value === 'string' && (CUSTOMER_PRESET_IDS as readonly string[]).includes(value);
}

/** Query selection is a presentation-only feature of the public demo. */
export function resolveCustomerPreset(configured: unknown, requested?: unknown, demo = false): CustomerPresetId {
  if (demo && isCustomerPresetId(requested)) return requested;
  return isCustomerPresetId(configured) ? configured : 'general';
}

export function customerPreviewHref(path: '/' | '/demo', preset: CustomerPresetId, locale: 'en' | 'zh'): string {
  return `${path}?preset=${preset}&locale=${locale}`;
}

function copy(
  name: string, description: string, heroTitle: string, heroBody: string, greeting: string,
  workflows: CustomerPresetCopy['workflows'], example: CustomerPresetCopy['example'],
): CustomerPresetCopy {
  return { name, description, heroTitle, heroBody, greeting, workflows, example, prompts: workflows.map((item) => item.prompt) };
}

const presets: Record<CustomerPresetId, CustomerPreset> = {
  general: {
    id: 'general', accent: '#777e69', instructions: '',
    en: copy('General Assistant', 'An adaptable assistant for everyday work.', 'Your own AI assistant that gets work done.', 'A private place to write, plan and think through your next task.', 'What would you like to work on?', [
      { kicker: 'Plan', title: 'Find your next step', prompt: 'Help me turn my task list into a realistic plan for today.', result: 'A short plan with clear priorities' },
      { kicker: 'Write', title: 'Find the right words', prompt: 'Help me write a clear reply to this message.', result: 'A draft you can review and edit' },
      { kicker: 'Think', title: 'Work through a decision', prompt: 'Help me compare these options and identify what I need to check.', result: 'A comparison with open questions' },
    ], { user: 'Turn these notes into a short update.', assistant: 'Here is a draft for you to review.', resultTitle: 'Project update', result1: 'The outline is ready for review.', result2: 'Next: agree on the scope.' }),
    zh: copy('通用助手', '处理日常工作，灵活适应你的需要。', '真正帮你把事情做完的专属 AI 助手。', '在专属空间里写作、规划，理清下一步。', '今天想一起处理什么？', [
      { kicker: '规划', title: '理清下一步', prompt: '帮我把待办事项整理成今天可以完成的计划。', result: '重点清楚的简短计划' },
      { kicker: '写作', title: '把意思说清楚', prompt: '帮我给这条消息写一份清晰的回复。', result: '可供检查和修改的草稿' },
      { kicker: '思考', title: '比较不同选择', prompt: '帮我比较这些方案，并列出还需要确认的信息。', result: '方案对比与待确认问题' },
    ], { user: '把这些笔记整理成一份简短进度更新。', assistant: '这是一份供你检查的草稿。', resultTitle: '项目进度', result1: '大纲已完成，等待审核。', result2: '下一步：确认范围。' }),
  },
  creator: {
    id: 'creator', accent: '#a64b35',
    instructions: 'Help creators turn their own ideas and source material into scripts, captions and practical publishing plans. Ask about audience, channel, tone and constraints when needed. Offer specific drafts and a concise revision checklist. Preserve the creator’s voice. Distinguish proposed content from verified facts. Never claim to have generated media, published a post or connected an account without an available tool and its confirmed result. Ask before external publishing.',
    en: copy('Creator Studio', 'Scripts, captions and content plans for creators.', 'Make your next idea worth sharing.', 'Turn a rough brief into a script, a stronger caption and a practical content plan. Keep your voice in every draft.', 'What are you making, and who is it for?', [
      { kicker: 'Script', title: 'Give your video a clear story', prompt: 'Help me outline a 30-second video. Ask about my audience and idea, then draft a hook, three shots and a closing line.', result: 'A short script and shot list to review' },
      { kicker: 'Caption', title: 'Sound like yourself', prompt: 'Rewrite my caption in three versions: direct, playful and thoughtful. Keep the facts and avoid invented claims.', result: 'Three captions with different tones' },
      { kicker: 'Plan', title: 'Build a week of useful posts', prompt: 'Help me plan five posts around one topic, with a purpose, opening line and format for each.', result: 'A focused weekly content plan' },
    ], { user: 'I filmed a rainy morning in my workshop. Help me write a quiet caption.', assistant: 'Here are two directions. Pick the one that sounds like you.', resultTitle: 'Caption drafts', result1: 'Rain outside. Small things taking shape inside.', result2: 'A slow morning, a warm lamp, one piece at a time.' }),
    zh: copy('创作者工作室', '为创作者准备脚本、文案与内容计划。', '把下一个灵感，变成值得分享的内容。', '从简单想法到视频脚本、贴文文案与内容计划，每份草稿都保留你的表达方式。', '这次想做什么内容？希望谁看到？', [
      { kicker: '脚本', title: '让视频有清晰的故事', prompt: '帮我规划一个30秒视频。先了解受众和想法，再写开场、三个镜头和结尾。', result: '可供修改的短脚本与分镜清单' },
      { kicker: '文案', title: '保留自己的表达', prompt: '把我的文案改写成直接、轻松和有思考感三个版本。保留事实，不编造效果。', result: '三种不同语气的文案' },
      { kicker: '计划', title: '安排一周内容', prompt: '围绕一个主题帮我规划五篇内容，分别列出目的、开头和呈现形式。', result: '主题明确的一周内容计划' },
    ], { user: '拍了一段雨天在工作室做手工的视频，帮我写一句安静一点的文案。', assistant: '给你两个方向，选更像你平时说话的那个。', resultTitle: '文案草稿', result1: '窗外下雨，屋里慢慢做成一件小东西。', result2: '一盏暖灯，一段不赶时间的早晨。' }),
  },
  office: {
    id: 'office', accent: '#38675f',
    instructions: 'Help people turn workplace notes and supplied documents into clear summaries, action lists, report drafts and process checklists. Separate confirmed facts from missing information. Preserve dates, amounts and responsibilities accurately; do not invent them. Ask for source material before summarizing it. Prepare drafts for review. Do not claim to have edited a file, sent email, updated an ERP or scheduled a task unless the required tool is available and confirms success. Ask before sending or changing external records.',
    en: copy('Office Assistant', 'Clear documents, updates and action lists for busy teams.', 'Less time sorting notes. More time moving work forward.', 'Turn the information you provide into clear updates, useful checklists and drafts your team can review.', 'Bring your notes or a task. What needs to be ready next?', [
      { kicker: 'Summarize', title: 'Leave meetings with a plan', prompt: 'Turn my meeting notes into decisions, action items, owners and due dates. Mark missing details instead of guessing.', result: 'An action list with gaps clearly marked' },
      { kicker: 'Report', title: 'Write a useful progress update', prompt: 'Use my notes to draft a weekly update with completed work, blockers and next steps.', result: 'A concise update ready for review' },
      { kicker: 'Process', title: 'Make repeat work easier', prompt: 'Help me turn this recurring task into a checklist, including the inputs, review steps and handoff.', result: 'A reusable process checklist' },
    ], { user: 'Notes: outline approved; supplier estimate missing; review Friday. Turn this into an update.', assistant: 'Here is a draft. The owner of the supplier follow-up still needs confirming.', resultTitle: 'Weekly update', result1: 'Completed: the outline is approved.', result2: 'Next: get the supplier estimate before Friday’s review.' }),
    zh: copy('办公助手', '把文档、进度和待办整理清楚。', '少花时间整理，多推进一点工作。', '把你提供的信息整理成清晰的进度更新、实用清单与供团队审核的文稿。', '把笔记或任务交给我。接下来需要准备好什么？', [
      { kicker: '总结', title: '会后知道下一步', prompt: '把我的会议笔记整理成决策、待办、负责人和截止日期。缺少的信息标出来，不要猜测。', result: '标明待确认信息的行动清单' },
      { kicker: '汇报', title: '写清工作进度', prompt: '根据我的笔记写一份周报，包含已完成事项、阻碍和下一步。', result: '可供审核的简洁周报' },
      { kicker: '流程', title: '让重复工作更省心', prompt: '帮我把这项常规任务整理成操作清单，包含所需材料、检查步骤和交接要求。', result: '可重复使用的流程清单' },
    ], { user: '笔记：大纲已通过；供应商报价没到；周五评审。整理成进度更新。', assistant: '草稿如下。跟进供应商的负责人还需要确认。', resultTitle: '本周进度', result1: '已完成：大纲通过审核。', result2: '下一步：周五评审前取得供应商报价。' }),
  },
  builder: {
    id: 'builder', accent: '#4d5a9b',
    instructions: 'Help developers and independent builders scope, understand, review and improve software. Ask for the relevant code, environment and acceptance criteria. Prefer small reviewable changes, accessible interfaces and explicit verification steps. Explain assumptions and tradeoffs. Never invent repository access, tool results, passing tests or deployment success. Distinguish suggested code from applied changes. Ask before production deployment or destructive operations. Protect secrets and use placeholders in examples.',
    en: copy('Website & App Builder', 'Scope features, review code and plan clearer interfaces.', 'From a rough requirement to a buildable plan.', 'Work through feature scope, code changes and interface details with an assistant that keeps the next step clear.', 'What are you building? Share the goal or the code you want to improve.', [
      { kicker: 'Scope', title: 'Start with a smaller first release', prompt: 'Help me scope the first version of my app: users, core flow, what to leave out and acceptance checks.', result: 'A focused implementation brief' },
      { kicker: 'Review', title: 'Understand before changing', prompt: 'Review this code for correctness and maintainability. Explain the risks and suggest a small first change.', result: 'Prioritized findings and a proposed patch' },
      { kicker: 'Interface', title: 'Make the screen easier to use', prompt: 'Review this interface description for keyboard access, readable labels and small-screen layout. Give me a concrete checklist.', result: 'An actionable interface review' },
    ], { user: 'I need a booking form. What belongs in the first version?', assistant: 'Start with the minimum flow, then decide how availability will be confirmed.', resultTitle: 'First-release scope', result1: 'Collect a service, preferred date and contact details.', result2: 'Show a request confirmation; avoid promising an unverified booking.' }),
    zh: copy('网站与应用助手', '梳理功能、审阅代码、改善界面。', '从模糊需求，到可以动手的方案。', '一起理清功能范围、代码改动和界面细节，让每一步都有明确目标。', '你在开发什么？可以先发目标，或想改进的代码。', [
      { kicker: '需求', title: '先做一个更小的版本', prompt: '帮我梳理应用第一版的用户、核心流程、暂不实现的功能和验收标准。', result: '范围明确的实施说明' },
      { kicker: '审阅', title: '理解后再改动', prompt: '检查这段代码的正确性和可维护性，解释风险，并建议一个小范围的首轮修改。', result: '按优先级整理的问题与修改建议' },
      { kicker: '界面', title: '让页面更容易使用', prompt: '根据这份界面描述检查键盘操作、文字标签和小屏布局，给我一份具体的改进清单。', result: '可以逐项执行的界面检查清单' },
    ], { user: '我想做一个预约表单，第一版应该包含什么？', assistant: '先明确最小流程，再决定如何确认可预约时间。', resultTitle: '第一版范围', result1: '收集服务项目、意向日期和联系方式。', result2: '显示申请已收到，不承诺尚未确认的预约。' }),
  },
  study: {
    id: 'study', accent: '#8c652f',
    instructions: 'Be a patient study coach. Help learners understand concepts, organize their own notes and practise recall. Ask about their level and goal. Explain reasoning in manageable steps, offer a hint before a full solution when useful, and invite the learner to try. Generate practice questions and explain answers. Do not invent citations or claim to have read material that was not supplied. Support learning rather than impersonating the student or completing a live graded assessment for them. Adapt language to the learner.',
    en: copy('Study Coach', 'Understand topics, organize notes and practise what you learn.', 'Understand it. Practise it. Make it stick.', 'Break down a difficult topic, turn your notes into a revision plan and check your understanding with practice questions.', 'What are you learning, and where did you get stuck?', [
      { kicker: 'Understand', title: 'Find the missing step', prompt: 'Explain this topic at my level, one step at a time. Ask me a short question to check my understanding.', result: 'An explanation followed by a check-in' },
      { kicker: 'Revise', title: 'Give your notes a structure', prompt: 'Turn these notes into a compact outline and five flashcards. Keep to the material I provide.', result: 'A revision outline and recall cards' },
      { kicker: 'Practise', title: 'Learn from your mistakes', prompt: 'Create five practice questions on this topic. Let me answer before showing explanations.', result: 'A short practice session with feedback' },
    ], { user: 'I mix up perimeter and area. Can you help me remember?', assistant: 'Think of a fence around a garden and the grass inside it. Which one measures the fence?', resultTitle: 'Try it yourself', result1: 'Perimeter measures the distance around the edge.', result2: 'Area measures the space inside. Try a 3 by 4 rectangle.' }),
    zh: copy('学习教练', '理解知识、整理笔记、练习巩固。', '弄懂它，练一练，真正记住。', '拆解难懂的知识，把笔记整理成复习计划，再用练习题检查理解程度。', '你在学什么？哪一步还没想明白？', [
      { kicker: '理解', title: '找到没弄懂的那一步', prompt: '根据我的水平一步步解释这个知识点，再问我一个小问题检查理解。', result: '分步讲解与理解检查' },
      { kicker: '复习', title: '把笔记整理成体系', prompt: '把这些笔记整理成精简大纲和五张记忆卡片，只使用我提供的材料。', result: '复习大纲与记忆卡片' },
      { kicker: '练习', title: '从错误里学会', prompt: '围绕这个主题出五道练习题，先让我作答，再给答案解析。', result: '带反馈的简短练习' },
    ], { user: '我总分不清周长和面积，怎么记？', assistant: '想象花园周围的围栏和里面的草地。围栏对应哪一个？', resultTitle: '自己试一试', result1: '周长是沿边缘走一圈的距离。', result2: '面积是内部占据的大小。试试长4宽3的长方形。' }),
  },
  business: {
    id: 'business', accent: '#9b4a69',
    instructions: 'Help small businesses prepare clear product information, customer reply drafts and practical marketing plans. Ask for the actual offer, audience, prices and service boundaries. Do not invent product claims, discounts, stock, reviews or results. Identify questions that need the owner’s confirmation. Keep payment and final order decisions with the business owner. Draft messages for review; never claim to have sent a reply, published content, collected payment or changed an order without an available tool, authorization and confirmed result.',
    en: copy('Small-business Assistant', 'Product answers, customer reply drafts and local marketing.', 'Be ready for the next customer question.', 'Prepare clear product answers and thoughtful follow-ups. Turn your real offer into useful content for the people you serve.', 'Tell me what you sell, or share a customer question you want to answer.', [
      { kicker: 'Reply', title: 'Answer with the facts', prompt: 'Draft a friendly reply to this customer enquiry using my product details. Flag anything I need to confirm.', result: 'A reply draft with owner questions' },
      { kicker: 'Offer', title: 'Make the offer easy to understand', prompt: 'Help me explain this product: who it is for, what is included, the price and the next step. Do not invent claims.', result: 'A clear product description' },
      { kicker: 'Content', title: 'Show what makes your business useful', prompt: 'Plan five social posts for my local business using the details I provide. Include a useful idea and a simple call to action for each.', result: 'A practical content plan to review' },
    ], { user: 'A customer asks if our lunch box can be vegetarian. The menu has not been confirmed.', assistant: 'Keep the reply helpful without promising an option you cannot confirm yet.', resultTitle: 'Customer reply draft', result1: 'Thanks for asking! I will check the vegetarian options with the kitchen.', result2: 'Which date and how many portions would you need?' }),
    zh: copy('小生意助手', '整理产品信息、客户回复与本地营销内容。', '下一位客户提问时，你已经有准备。', '写清产品答案，准备周到的跟进回复，把真实的服务变成客户看得懂的内容。', '你经营什么生意？也可以先发一个需要回复的客户问题。', [
      { kicker: '回复', title: '根据事实回答客户', prompt: '根据我的产品信息给这条客户咨询写一份友好回复，把需要我确认的内容标出来。', result: '回复草稿与待确认问题' },
      { kicker: '产品', title: '把产品说清楚', prompt: '帮我说明这个产品适合谁、包含什么、价格多少以及下一步怎么做。不要编造卖点。', result: '清晰的产品介绍' },
      { kicker: '内容', title: '让客户看懂你的价值', prompt: '根据我提供的信息，为本地生意规划五篇社交平台内容，每篇包含一个有用的信息和简单的行动建议。', result: '可供审核的实用内容计划' },
    ], { user: '客户问午餐盒能不能做素食，但菜单还没确定。', assistant: '可以积极回应，同时不承诺还没确认的选项。', resultTitle: '客户回复草稿', result1: '谢谢咨询！我先和厨房确认一下素食选择。', result2: '请问您需要哪一天、多少份？' }),
  },
};

export function getCustomerPreset(id: CustomerPresetId): CustomerPreset {
  return presets[id];
}
