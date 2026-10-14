// 从 al-Ṯurayyā 地名辞典导入伊斯兰世界的区府，写入 data/admin_800.json。
// 用法：node scripts/import-althurayya.mjs <places.geojson>
//
// 数据来源：al-Ṯurayyā Gazetteer Project, https://github.com/althurayya/althurayya.github.io
// 许可：CC BY 4.0。坐标源自 Georgette Cornu《古典时期阿拉伯-伊斯兰世界地图集》，
// 区划框架为 10 世纪地理学家穆卡达西（al-Muqaddasī）的体系。
//
// 导入的是"大都会"（metropoles）、"区府"（capitals）以及安达卢斯的科拉（district/region）。
// 原有手工治所若与导入的治所相距不到 40 公里，视为重复并删除（以 al-Ṯurayyā 的坐标为准）。
import fs from "node:fs";

const [, , input] = process.argv;
const ADMIN = "data/admin_800.json";
const GROUP = "伊斯兰世界（al-Ṯurayyā）";
const DEDUPE_KM = 40;

// 800 年时尚不存在的城市
const EXCLUDE = new Set([
  "SAMARRA_438E342N_S", // 836 年建都
  "ZABID_433E142N_S", // 819 年建城
]);

const ZH = {
  WASHQA_003W421N_R: "韦斯卡", BALANSIYYA_004W394N_R: "瓦伦西亚", SARAQUSA_009W416N_R: "萨拉戈萨",
  TUDMIR_013W379N_R: "托德米尔", TUTILA_016W420N_R: "图德拉", BAJJANA_024W369N_R: "佩希纳",
  WADIHIJARA_031W406N_R: "瓜达拉哈拉", LIBIRA_036W372N_R: "埃尔维拉", TULAYTILA_040W398N_R: "托莱多",
  RAYYA_044W369N_R: "雷亚", MALIQA_044W367N_R: "马拉加", QURTUBA_047W379N_S: "科尔多瓦",
  FAHSBALLUT_048W386N_R: "法赫斯·巴卢特", JAZIRAKHADRA_054W361N_R: "阿尔赫西拉斯", FIRRISH_055W379N_R: "菲里什",
  SHADHUNA_059W364N_R: "锡多尼亚", ISHBILIYYA_059W374N_R: "塞维利亚", BATALYUS_069W388N_R: "巴达霍斯",
  BAJA_078W380N_R: "贝雅", KHUSHUNUBA_079W370N_R: "奥克索诺巴",
  RAQQA_390E359N_S: "拉卡", AMID_402E379N_S: "阿米达", ARABAN_406E360N_S: "阿拉班", MAWSIL_431E363N_S: "摩苏尔",
  BARQA_208E323N_S: "巴尔卡", AMUL_524E364N_S: "阿莫勒", DAMGHAN_543E361N_S: "达姆甘",
  SHAHRASTAN_552E371N_S: "戈尔甘", AKHUR_557E391N_S: "阿胡尔",
  ISKANDARIYYA_299E311N_S: "亚历山大", FAYYUM_306E294N_S: "法尤姆", FUSTAT_312E300N_S: "福斯塔特",
  BILBAYS_315E304N_S: "比勒拜斯", FARAMA_325E310N_S: "法拉马", USWAN_329E241N_S: "阿斯旺",
  ARRAJAN_502E306N_S: "阿拉詹", SHAHRASTAN_515E298N_S: "比沙普尔", SIRAF_523E276N_S: "西拉夫",
  SHIRAZ_525E296N_S: "设拉子", ISTAKHR_529E299N_S: "伊斯塔赫尔", NAYRIZ_542E292N_S: "内里兹",
  KHASU_544E285N_S: "哈苏", DARABAJIRD_545E287N_S: "达拉卜吉尔德",
  BAGHDAD_443E333N_S: "巴格达", KUFA_443E320N_S: "库法", HULWAN_459E344N_S: "胡尔万",
  WASIT_463E321N_S: "瓦西特", BASRA_477E304N_S: "巴士拉",
  QURH_379E265N_S: "库尔赫", MAKKA_398E213N_S: "麦加", HAJR_467E246N_S: "哈杰尔", AHSA_495E253N_S: "艾哈萨",
  SUHAR_566E243N_S: "苏哈尔",
  SAYMARA_474E331N_S: "塞马拉", DINAWAR_474E346N_S: "迪纳瓦尔", NIHAWAND_483E342N_S: "尼哈万德",
  HAMADHAN_485E347N_S: "哈马丹", BURUJIRD_488E339N_S: "布鲁杰尔德", KARAJ_495E338N_S: "卡拉季",
  SARUQ_495E343N_S: "萨鲁格", QUMM_509E346N_S: "库姆", QASHAN_515E339N_S: "卡尚", RAYY_515E356N_S: "赖伊",
  ISBAHAN_516E326N_S: "伊斯法罕",
  ITIL_480E462N_S: "伊蒂尔",
  AZADHWAR_565E366N_S: "阿扎德瓦尔", TURTHITH_584E351N_S: "图尔希兹", KHUJAN_584E369N_S: "古昌",
  NAYSABUR_587E361N_S: "内沙布尔", QAYIN_590E336N_S: "加因", TUS_594E364N_S: "图斯",
  BUSANJ_614E343N_S: "布尚吉", MARW_621E376N_S: "木鹿", ASFUZAR_621E332N_S: "阿斯富扎尔",
  HARA_621E343N_S: "赫拉特", DIHISTAN_629E346N_S: "迪希斯坦", MARWRUDH_633E355N_S: "木鹿鲁德",
  BALKH_668E367N_S: "巴尔赫", BAMIYAN_678E348N_S: "巴米扬",
  SUS_482E322N_S: "苏萨", JUNDAYSABUR_485E322N_S: "贡德沙普尔", AHWAZ_486E313N_S: "阿瓦士",
  TUSTAR_488E320N_S: "舒什塔尔", ASKARMUKRAM_488E316N_S: "阿斯卡尔·穆克拉姆", DAWRAQ_489E308N_S: "道拉格",
  RAMHURMUZ_496E312N_S: "拉姆霍尔木兹", HAWMAZUTT_497E310N_S: "祖特",
  SIRJAN_557E294N_S: "锡尔詹", JIRUFT_578E286N_S: "吉罗夫特", BAMM_583E291N_S: "巴姆", NARMASIR_586E289N_S: "纳尔马希尔",
  SIJILMASA_042W312N_S: "西吉勒马萨", FAS_050W340N_S: "菲斯", TARQALA_088W305N_S: "塔尔卡拉",
  TAHIRT_013E353N_S: "提亚雷特", QAYRAWAN_101E357N_S: "凯鲁万", SUBAYTILA_092E352N_S: "斯贝特拉",
  DABIL_446E401N_S: "德温", BARDHAA_472E404N_S: "巴尔达", ARDABIL_483E382N_S: "阿尔达比勒", MUGHAN_485E393N_S: "穆甘",
  RAMLA_348E319N_S: "拉姆拉", TABARIYYA_355E327N_S: "太巴列", ADHRUH_357E303N_S: "乌兹鲁赫",
  ADHRIAT_360E326N_S: "德拉", DIMASHQ_363E335N_S: "大马士革", HIMS_367E347N_S: "霍姆斯",
  QINNASRIN_370E359N_S: "肯奈斯林", HALAB_371E361N_S: "阿勒颇",
  BALARM_133E381N_S: "巴勒莫",
  ZARANJ_616E307N_S: "扎兰季", BUST_643E313N_S: "博斯特", DARTAL_650E321N_S: "达尔塔勒", SIWI_678E295N_S: "锡维",
  GHAZNA_684E335N_S: "加兹尼",
  BANNAJBUR_641E269N_S: "潘杰古尔", MANSURA_688E258N_S: "曼苏拉", WAYHIND_722E339N_S: "乌德班达普拉",
  QANNAWJ_800E271N_S: "曲女城",
  JURJANIYYA_592E424N_S: "古尔甘奇", KATH_607E417N_S: "柯提", BUKHARA_644E398N_S: "布哈拉",
  AKHSISAK_652E378N_S: "阿赫西萨克", NASAF_658E388N_S: "那色波", KISHSH_668E390N_S: "碣石（史国）",
  SAMARQAND_670E396N_S: "撒马尔罕", ABARKATH_673E397N_S: "阿巴尔卡特", SAGHANIYAN_678E382N_S: "石汗那",
  QUBADHIYAN_681E372N_S: "久越得建", BUMJIKATH_688E397N_S: "苏对沙那", WASHJIRD_692E384N_S: "瓦什吉尔德",
  BINKATH_694E412N_S: "赭时", ISBIJAB_697E422N_S: "白水城", HULBUK_698E378N_S: "胡尔布克",
  TUNKATH_702E410N_S: "吐屯城", KHAYLAM_709E411N_S: "海拉姆", AKHSHIKATH_713E409N_S: "拔汗那",
  KARWAN_718E414N_S: "卡尔万",
  ATTAR_423E171N_S: "阿塔尔", THUJJA_441E139N_S: "图杰", SANA_442E153N_S: "萨那",
  ABYAYN_449E131N_S: "阿比扬", MARIB_454E155N_S: "马里卜",
};

const src = JSON.parse(fs.readFileSync(input, "utf8"));
const seats = [];
for (const f of src.features) {
  const p = f.properties.cornuData;
  const t = p.top_type_hom;
  const isSeat = t === "metropoles" || t === "capitals"
    || (p.region_code === "Andalus" && t === "regions" && ["district", "region"].includes(p.top_type_orig));
  if (!isSeat || EXCLUDE.has(p.cornu_URI)) continue;
  const name = ZH[p.cornu_URI] ?? p.toponym_buckwalter.split(",")[0].trim();
  seats.push([name, Number(Number(p.coord_lon).toFixed(3)), Number(Number(p.coord_lat).toFixed(3)), p.cornu_URI]);
}

function km([, lon1, lat1], [, lon2, lat2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

const admin = JSON.parse(fs.readFileSync(ADMIN, "utf8"));
admin.groups = admin.groups.filter((g) => g.polity !== GROUP);
const removed = [];
for (const g of admin.groups) {
  g.seats = g.seats.filter((s) => {
    const dup = seats.find((t) => km(s, t) < DEDUPE_KM);
    if (dup) removed.push(`${s[0]} → ${dup[0]}`);
    return !dup;
  });
}
admin.groups = admin.groups.filter((g) => g.seats.length);
admin.groups.push({
  polity: GROUP,
  unit: "穆卡达西体系下的大都会与区府；安达卢斯为科拉（kura）",
  source: "al-Ṯurayyā Gazetteer Project, https://github.com/althurayya/althurayya.github.io, CC BY 4.0（第四列为其地名 URI）",
  seats,
});

// 保持一行一个治所，方便人工核对
const text = JSON.stringify(admin, null, 2).replace(/\[\s+("[^"]*"),\s+(-?[\d.]+),\s+(-?[\d.]+)(?:,\s+("[^"]*"))?\s+\]/g,
  (_, n, x, y, u) => `[${n}, ${x}, ${y}${u ? `, ${u}` : ""}]`);
fs.writeFileSync(ADMIN, text + "\n");
console.log(`导入 ${seats.length} 个治所；替换掉重复的手工治所 ${removed.length} 个：`);
console.log("  " + removed.join("，"));
