// Algorithmic Chinese → Russian transliteration (Палладиевая система),
// the canonical scheme for rendering Mandarin in Cyrillic. Used as a
// post-process for dictionary entries: for proper-noun terms whose
// source form is pure CJK, Palladius gives the standard Russian
// rendering — usually better than what an LLM produces, especially
// for novel-specific names with no Wikipedia presence.
//
// Pipeline: Chinese characters → Pinyin (via pinyin-pro) → Palladius
// (via the syllable table + post-process rules in this file). Both
// stages run client-side so the browser builds a dictionary with no
// network calls.
//
// pinyin-pro is loaded as a UMD via <script> in index.html /
// bilingual.html, exposing `globalThis.pinyinPro.pinyin(...)`. Tests
// inject their own pinyin function via `opts.pinyinFn` so they don't
// need a network or npm dep — the pure Pinyin → Cyrillic step
// (`pinyinToPalladius`) is the part with logic worth testing anyway.
//
// The mapping table and conversion rules below are extracted (with
// rewrites for readability) from the bundled JS at palladius.ru — the
// same authority the old.palladius.ru API uses. Maintained here to
// avoid the CORS / proxy dance that the public API forces.

const CJK = /[㐀-䶿一-鿿]/;

export function isMostlyCJK(s) {
  if (!s) return false;
  const nonWs = String(s).replace(/\s/g, '');
  if (!nonWs) return false;
  let cjk = 0;
  for (const ch of nonWs) if (CJK.test(ch)) cjk++;
  return cjk * 2 >= nonWs.length;
}

// Pinyin syllable → Cyrillic. Includes:
//   - Standard syllables (ba…zuo, etc.).
//   - Single-letter onsets (a / e / o / m / n / ng) plus a few common
//     Han characters that the upstream table hard-codes for fallback.
//   - Pairs (e.g. hui → ["хуэй","хой"]) where the second form is the
//     geographic-name spelling.
const SYLLABLE = {
  a:'а', e:'э', o:'о', m:'м', ng:'н',
  ai:'ай', an:'ань', ao:'ао', ei:'эй', en:'энь', er:'эр', ou:'оу',
  ang:'ан', eng:'эн', ing:'ин', ong:'ун',
  '儿':'эр', '金':'цзинь', '语':'юй', '叶':'е', '长':'чан', '明':'мин', '童':'тун',
  hui:['хуэй','хой'], feng:['фэн','фын'], meng:['мэн','мын'],
  fen:['фэнь','фынь'], men:['мэнь','мынь'],
  mm:'мм', hm:'хм', hng:'хн', rem:'жэм', zem:'цзэм', yo:['йо','ё'],
  ca:'ца', cai:'цай', can:'цань', cang:'цан', cao:'цао', ce:'цэ', cei:'цэй',
  cen:'цэнь', ceng:'цэн', ci:'цы', cong:'цун', cou:'цоу', cu:'цу', cuan:'цуань',
  cui:'цуй', cun:'цунь', cuo:'цо',
  ran:'жань', rang:'жан', rao:'жао', re:'жэ', ren:'жэнь', reng:'жэн', ri:'жи',
  rong:'жун', rou:'жоу', ru:'жу', rua:'жуа', ruan:'жуань', rui:'жуй', run:'жунь', ruo:'жо',
  za:'цза', zai:'цзай', zan:'цзань', zang:'цзан', zao:'цзао', ze:'цзэ', zei:'цзэй',
  zen:'цзэнь', zeng:'цзэн', zi:'цзы', zong:'цзун', zou:'цзоу', zu:'цзу', zuan:'цзуань',
  zui:'цзуй', zun:'цзунь', zuo:'цзо',
  ba:'ба', bai:'бай', ban:'бань', bang:'бан', bao:'бао', bo:'бо', bi:'би',
  bian:'бянь', biao:'бяо', bie:'бе', bin:'бинь', bing:'бин', bu:'бу',
  bei:'бэй', ben:'бэнь', beng:'бэн',
  pa:'па', pai:'пай', pan:'пань', pang:'пан', pao:'пао', po:'по', pi:'пи',
  pian:'пянь', piao:'пяо', pie:'пе', pin:'пинь', ping:'пин', pu:'пу',
  pei:'пэй', pen:'пэнь', peng:'пэн', piang:'пян', pou:'поу',
  ma:'ма', mai:'май', man:'мань', mang:'ман', mao:'мао', mo:'мо', mi:'ми',
  mian:'мянь', miao:'мяо', mie:'ме', min:'минь', ming:'мин', miu:'мю', mu:'му',
  me:'мэ', mei:'мэй', mou:'моу',
  fa:'фа', fan:'фань', fang:'фан', fei:'фэй', fo:'фо', fu:'фу', fou:'фоу', fiao:'фяо',
  da:'да', dai:'дай', dan:'дань', dang:'дан', dao:'дао', de:'дэ', dei:'дэй',
  den:'дэнь', deng:'дэн', di:'ди', dia:'дя', dian:'дянь', diang:'дян', diao:'дяо',
  die:'де', ding:'дин', diu:'дю', dong:'дун', dou:'доу', du:'ду',
  duan:'дуань', dui:'дуй', dun:'дунь', duo:'до',
  ta:'та', tai:'тай', tan:'тань', tang:'тан', tao:'тао', te:'тэ', tei:'тэй',
  ten:'тэнь', teng:'тэн', ti:'ти', tian:'тянь', tiang:'тян', tiao:'тяо',
  tie:'те', ting:'тин', tong:'тун', tou:'тоу', tu:'ту',
  tuan:'туань', tui:'туй', tun:'тунь', tuo:'то',
  na:'на', nai:'най', nan:'нань', nang:'нан', nao:'нао', ne:'нэ', nei:'нэй',
  nen:'нэнь', neng:'нэн', ni:'ни', nia:'ня', nian:'нянь', niang:'нян', niao:'няо',
  nie:'не', nin:'нинь', ning:'нин', niu:'ню', nong:'нун', nou:'ноу', nu:'ну',
  nun:'нунь', nuan:'нуань', nuo:'но', 'nü':'нюй', 'nüe':'нюэ',
  la:'ла', lai:'лай', lan:'лань', lang:'лан', lao:'лао', le:'лэ', lei:'лэй',
  leng:'лэн', li:'ли', lia:'ля', lian:'лянь', liang:'лян', liao:'ляо',
  lie:'ле', lin:'линь', ling:'лин', liu:'лю', lo:'ло', long:'лун', lou:'лоу', lu:'лу',
  'lü':'люй', luan:'луань', 'lüan':'люань', 'lüe':'люэ', lun:'лунь', 'lün':'люнь', luo:'ло',
  ga:'га', gai:'гай', gan:'гань', gang:'ган', gao:'гао', ge:'гэ', gei:'гэй',
  gen:'гэнь', geng:'гэн', go:'го', gong:'гун', gou:'гоу', gu:'гу',
  gua:'гуа', guai:'гуай', guan:'гуань', guang:'гуан', gui:'гуй', gun:'гунь', guo:'го',
  ka:'ка', kai:'кай', kan:'кань', kang:'кан', kao:'као', ke:'кэ', kei:'кэй',
  ken:'кэнь', keng:'кэн', kong:'кун', kou:'коу', ku:'ку',
  kua:'куа', kuai:'куай', kuan:'куань', kuang:'куан', kui:'куй', kun:'кунь', kuo:'ко',
  ha:'ха', hai:'хай', han:'хань', hang:'хан', hao:'хао', he:'хэ', hei:'хэй',
  hen:'хэнь', heng:'хэн', hong:'хун', hou:'хоу', hu:'ху',
  hua:'хуа', huai:'хуай', huan:'хуань', huang:'хуан', hun:'хунь', huo:'хо',
  zha:'чжа', zhai:'чжай', zhan:'чжань', zhang:'чжан', zhao:'чжао', zhe:'чжэ', zhei:'чжэй',
  zhen:'чжэнь', zheng:'чжэн', zhi:'чжи', zhong:'чжун', zhou:'чжоу', zhu:'чжу',
  zhua:'чжуа', zhuai:'чжуай', zhuan:'чжуань', zhuang:'чжуан', zhui:'чжуй', zhun:'чжунь', zhuo:'чжо',
  cha:'ча', chai:'чай', chan:'чань', chang:'чан', chao:'чао', che:'чэ', chen:'чэнь',
  cheng:'чэн', chi:'чи', chong:'чун', chou:'чоу', chu:'чу',
  chua:'чуа', chuai:'чуай', chuan:'чуань', chuang:'чуан', chui:'чуй', chun:'чунь', chuo:'чо',
  sha:'ша', shai:'шай', shan:'шань', shang:'шан', shao:'шао', she:'шэ', shei:'шэй',
  shen:'шэнь', sheng:'шэн', shi:'ши', shou:'шоу', shu:'шу',
  shua:'шуа', shuai:'шуай', shuan:'шуань', shuang:'шуан', shui:'шуй', shun:'шунь', shuo:'шо',
  sa:'са', sai:'сай', san:'сань', sang:'сан', sao:'сао', se:'сэ', sei:'сэй',
  sen:'сэнь', seng:'сэн', si:'сы', song:'сун', sou:'соу', su:'су',
  suan:'суань', sui:'суй', sun:'сунь', suo:'со',
  ji:'цзи', jia:'цзя', jian:'цзянь', jiang:'цзян', jiao:'цзяо', jie:'цзе',
  jin:'цзинь', jing:'цзин', jiong:'цзюн', jiu:'цзю', ju:'цзюй',
  juan:'цзюань', jue:'цзюэ', jun:'цзюнь',
  qi:'ци', qia:'ця', qian:'цянь', qiang:'цян', qiao:'цяо', qie:'це',
  qin:'цинь', qing:'цин', qiong:'цюн', qiu:'цю', qu:'цюй',
  quan:'цюань', que:'цюэ', qun:'цюнь',
  xi:'си', xia:'ся', xian:'сянь', xiang:'сян', xiao:'сяо', xie:'се',
  xin:'синь', xing:'син', xiong:'сюн', xiu:'сю', xu:'сюй',
  xuan:'сюань', xue:'сюэ', xun:'сюнь',
  ya:'я', yai:'яй', yan:'янь', yang:'ян', yao:'яо', ye:'е', yi:'и',
  yin:'инь', ying:'ин', yo:'йо', yong:'юн', you:'ю',
  yu:'юй', yuan:'юань', yue:'юэ', yun:'юнь',
  wa:'ва', wai:'вай', wan:'вань', wang:'ван', wao:'вао', wei:'вэй',
  wen:'вэнь', weng:'вэн', wo:'во', wu:'у',
};

// Tokeniser order: longest pinyin syllables first so `chuang` matches
// before `ch`. Lifted verbatim from the upstream bundle's `ed` array
// (with stable sort across same-length entries).
const TOKEN_ORDER = [
  'chuang','shuang','zhuang','chang','cheng','chong','chuai','chuan','diang',
  'guang','huang','jiang','jiong','kuang','liang','niang','piang','qiang',
  'qiong','shang','sheng','shuai','shuan','tiang','xiang','xiong','zhang',
  'zheng','zhong','zhuai','zhuan','bang','beng','bian','biao','bing','cang',
  'ceng','chai','chan','chao','chen','chou','chua','chui','chun','chuo','cong',
  'cuan','dang','deng','dian','diao','ding','dong','duan','fang','feng','fiao',
  'gang','geng','gong','guai','guan','hang','heng','hong','huai','huan','jian',
  'jiao','jing','juan','kang','keng','kong','kuai','kuan','lang','leng','lian',
  'liao','ling','long','luan','liuan','mang','meng','mian','miao','ming','nang',
  'neng','nian','niao','ning','nong','nuan','pang','peng','pian','piao','ping',
  'qian','qiao','qing','quan','rang','reng','rong','ruan','sang','seng','shai',
  'shan','shao','shei','shen','shou','shua','shui','shun','shuo','song','suan',
  'tang','teng','tian','tiao','ting','tong','tuan','wang','weng','xian','xiao',
  'xing','xuan','yang','ying','yong','yuan','zang','zeng','zhai','zhan','zhao',
  'zhei','zhen','zhou','zhua','zhui','zhun','zhuo','zong','zuan',
  'ang','bai','ban','bao','bei','ben','bie','bin','cai','can','cao','cei','cen',
  'cha','che','chi','chu','cou','cui','cun','cuo','dai','dan','dao','dei','den',
  'dia','die','diu','dou','dui','dun','duo','eng','fan','fei','fen','fou','gai',
  'gan','gao','gei','gen','gou','gua','gui','gun','guo','hai','han','hao','hei',
  'hen','hng','hou','hua','hui','hun','huo','jia','jie','jin','jiu','jue','jun',
  'kai','kan','kao','kei','ken','kou','kua','kui','kun','kuo','lyu','lai','lan',
  'lao','lei','lia','lie','lin','liu','lou','lue','lun','luo','mai','man','mao',
  'mei','men','mie','min','miu','mou','nai','nan','nao','nei','nen','nia','nie',
  'nin','niu','nou','nüe','nun','nuo','pai','pan','pao','pei','pen','pie','pin',
  'pou','qia','qie','qin','qiu','que','qun','ran','rao','rem','ren','rou','rua',
  'rui','run','ruo','sai','san','sao','sei','sen','sha','she','shi','shu','sou',
  'sui','sun','suo','tai','tan','tao','tei','ten','tie','tou','tui','tun','tuo',
  'wai','wan','wao','wei','wen','xia','xie','xin','xiu','xue','xun','yai','yan',
  'yao','yin','you','yue','yun','zai','zan','zao','zei','zem','zen','zha','zhe',
  'zhi','zhu','zou','zui','zun','zuo',
  'ai','an','ao','ba','bi','bo','bu','ca','ce','ci','cu','da','de','di','du',
  'ei','en','er','fa','fo','fu','ga','ge','go','gu','ha','he','hm','hu','ji',
  'ju','ka','ke','ku','la','le','li','lo','lu','lü','ma','me','mi','mm','mo',
  'mu','na','ne','ng','ni','nu','nü','ou','pa','pi','po','pu','qi','qu','re',
  'ri','ru','sa','se','si','su','ta','te','ti','tu','wa','wo','wu','xi','xu',
  'ya','ye','yi','yo','yu','za','ze','zi','zu',
  'a','e','ê','m','n','o',
];

// Greedy left-to-right tokenization. For each step, take the longest
// prefix in TOKEN_ORDER; if none matches, fall through to a single
// SYLLABLE-table char (covers `a`/`e`/`o`/`m` and the hard-coded Han
// chars). If still no match, pass through unchanged so foreign tokens
// don't disappear.
function tokenize(word) {
  const out = [];
  let rest = word;
  while (rest.length > 0) {
    const lower = rest.toLowerCase();
    let matched = '';
    for (const t of TOKEN_ORDER) {
      if (lower.startsWith(t)) { matched = t; break; }
    }
    if (matched) {
      out.push(matched);
      rest = rest.slice(matched.length);
      continue;
    }
    const head = rest[0];
    if (SYLLABLE[head] != null) {
      out.push(head);
      rest = rest.slice(1);
      continue;
    }
    out.push(head);
    rest = rest.slice(1);
  }
  return out;
}

// Geographic spellings (`hui`, `feng`, `meng`, `fen`, `men`) override
// the standard ones. Applied to the assembled word, after token-level
// substitution, so it can also catch substring matches that survived
// tokenization.
function applyGeographicOverrides(word, isGeographic) {
  if (!isGeographic) return word;
  const swaps = {
    'хуэй': 'хой', 'фэн': 'фын', 'мэн': 'мын',
    'фэнь': 'фынь', 'мэнь': 'мынь',
  };
  for (const [from, to] of Object.entries(swaps)) {
    word = word.replace(new RegExp(from, 'g'), to);
  }
  return word;
}

// Per-syllable suffix fix: -ng → -н (drop the second consonant), -n at
// word boundary → -нь (soft sign). Negative-look-ahead `(?!ъ)` keeps
// the soft-sign rule from kicking in inside ъ-separated runs (which
// the main loop already handles).
function softenNasals(syllable) {
  return syllable.replace(/нг\b/g, 'н').replace(/н\b(?!ъ)/g, 'нь');
}

// Word-final/inter-word `-r` Erhua handling, plus a few special-case
// rules for awkward `эр`-cluster sequences. Adapted from the upstream
// `sd` function.
function fixErhua(text) {
  return text
    .replace(/([аеёиоуыэюя])r$/g, '$1р')
    .replace(/([аеёиоуыэюя])r(\s)/g, '$1р$2')
    .replace(/ээр(\s|$)/g, 'эр$1')
    .replace(/э\s+эр\b/g, 'эр')
    .replace(/([^э\s])\s+эр\b/g, '$1р')
    .replace(/([йн])эр$/g, '$1р')
    .replace(/([аиоуыэюя])эр$/g, '$1р')
    .replace(/([йн])эр(\s)/g, '$1р$2')
    .replace(/([аиоуыэюя])эр(\s)/g, '$1р$2')
    .replace(/йэр$/g, 'йр')
    .replace(/йэр(\s)/g, 'йр$1');
}

// Convert one space-separated pinyin string (e.g. "ruan mian fang ru
// qing") into Cyrillic Palladius. Pure: depends only on this module's
// tables. Options:
//   isGeographic     — switch to geographic-name spellings.
//   separateSyllables — keep a space between every syllable (default
//                       false: glue inside a word, like "Жуаньмянь",
//                       though for proper nouns we usually pass each
//                       name as a word so the join doesn't matter).
//   capitalizeWords  — Title-case each space-separated word.
export function pinyinToPalladius(pinyin, opts = {}) {
  const { isGeographic = false, separateSyllables = false, capitalizeWords = false } = opts;
  if (!pinyin) return '';
  let out = pinyin
    .split(/\s+/)
    .filter(Boolean)
    .map(word => {
      const tokens = tokenize(word);
      const cyrillic = tokens
        .map(t => {
          const v = SYLLABLE[t];
          if (Array.isArray(v)) return v[0];   // standard, not geographic
          return v != null ? v : t;
        })
        .map(s => softenNasals(s));
      let result = '';
      for (let i = 0; i < cyrillic.length; i++) {
        if (i > 0) {
          const prev = cyrillic[i - 1];
          const cur  = cyrillic[i];
          // ъ-separator: previous syllable ended in н, current starts
          // with a Russian vowel (й is treated like a vowel head here
          // because `я`, `е`, `ё`, `ю` already encode iotation).
          if (prev.endsWith('н') && /^[аеёиоуыэюя]/i.test(cur)) result += 'ъ';
          // Soft separator between two single-letter pinyin syllables
          // (e.g. `a` + `o`, where running them together produces a
          // Cyrillic blob), or whenever the caller asked for it.
          const tPrev = tokens[i - 1], tCur = tokens[i];
          const bothSingleLetterSyllable =
            tPrev.length === 1 && SYLLABLE[tPrev] != null &&
            tCur.length === 1 && SYLLABLE[tCur] != null;
          if (separateSyllables || bothSingleLetterSyllable) result += ' ';
        }
        result += cyrillic[i];
      }
      return result;
    })
    .join(' ');
  out = applyGeographicOverrides(out, isGeographic);
  out = fixErhua(out);
  if (capitalizeWords) {
    out = out.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  return out;
}

// Convert Chinese characters to Russian Palladius. Requires pinyin-pro
// to be loaded — either via the CDN <script> tag (browser) or via
// `opts.pinyinFn` injection (tests / Node scripts).
export function chineseToPalladius(text, opts = {}) {
  if (!text) return '';
  const pinyinFn = opts.pinyinFn ?? globalThis.pinyinPro?.pinyin;
  if (typeof pinyinFn !== 'function') {
    throw new Error(
      'pinyin-pro is not loaded. Browser: include the <script> tag for pinyin-pro UMD. ' +
      'Tests/Node: pass opts.pinyinFn.'
    );
  }
  const pinyin = pinyinFn(text, {
    toneType: 'none',
    type:     'string',
    nonZh:    'consecutive',
    separator: ' ',
  }).toLowerCase().replace(/\s+/g, ' ').trim();
  return pinyinToPalladius(pinyin, {
    isGeographic:    !!opts.isGeographic,
    separateSyllables: opts.separateSyllables ?? true,
    capitalizeWords: opts.capitalizeWords ?? true,
  });
}

// Take a list of Chinese strings, return Map<input, transliteration>.
// Inputs that aren't mostly CJK are dropped silently. Async to keep
// the call signature stable across the previous (network-based) and
// new (offline) implementations — the body is synchronous since
// pinyin-pro and the syllable table are local.
export async function palladiusTransliterate(strings, opts = {}) {
  const out = new Map();
  for (const s of strings || []) {
    if (typeof s !== 'string' || !isMostlyCJK(s)) continue;
    if (out.has(s)) continue;
    out.set(s, chineseToPalladius(s, opts));
  }
  return out;
}
