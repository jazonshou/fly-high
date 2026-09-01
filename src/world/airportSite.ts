import { sampleNaturalTerrainHeight } from "./terrain";
import { mixSeed, unitFloatFromHash } from "./seed";
import type { AirportDefinition } from "./types";

export type AirportFootprint = Pick<
  AirportDefinition,
  | "runwayLength"
  | "runwayWidth"
  | "endSafetyArea"
  | "shoulderWidth"
  | "terrainBlendDistance"
>;

export interface AirportSiteAssessment {
  /** Robust natural-ground datum used for the constructed runway. */
  readonly elevation: number;
  /** Lowest natural terrain beneath the runway platform, relative to sea level. */
  readonly minimumPlatformClearance: number;
  /** Natural relief that must be cut or filled beneath the hard platform. */
  readonly platformRelief: number;
  /** Greatest sampled natural grade along the runway centreline. */
  readonly longitudinalGrade: number;
  /** Greatest sampled natural grade across the runway and shoulders. */
  readonly crossGrade: number;
  /** Natural relief across the complete terrain-blend footprint. */
  readonly blendRelief: number;
  /** Lowest natural terrain in either sampled arrival/departure corridor. */
  readonly minimumApproachClearance: number;
  /** Metres by which the worst obstacle enters a conservative 3-degree approach surface. */
  readonly approachObstruction: number;
  readonly suitable: boolean;
  /** Lower scores are safer and require less terrain modification. */
  readonly score: number;
}

export interface GeneratedAirportSite {
  readonly centerX: number;
  readonly centerZ: number;
  readonly headingRadians: number;
  readonly assessment: AirportSiteAssessment;
}

export interface ResolvedAirportRegion {
  /** Terrain hash selected deterministically from the public world seed. */
  readonly seedHash: number;
  readonly site: GeneratedAirportSite;
  /** True when the source terrain had no suitable site inside the startup budget. */
  readonly usedFallbackRegion: boolean;
}

type SafeFlightRegionTuple = readonly [
  seedHash: number,
  centerX: number,
  centerZ: number,
  headingRadians: number,
];

// Prevalidated natural regions are a bounded safety net, not prebuilt airport
// terrain. Each tuple was accepted by assessAirportSite with the same strict
// dry-ground, earthwork, grade, blend, and approach constraints used at run
// time. The public seed deterministically selects a catalogue entry only when
// its own terrain cannot produce a safe site inside the synchronous browser
// startup budget.
const SAFE_FLIGHT_REGIONS = [
  [2494367150, -27612.193292466138, 19330.72757908224, 0.2686636582905315],
  [3371856212, 19667.959544262678, 995.4035351490038, 2.090074611814088],
  [2032988989, 4617.913419388873, -20492.039163650647, 1.928736354208433],
  [879399927, -17303.03273742392, -18612.68252767974, 1.4305751456816596],
  [640049535, -26107.795101330863, -16540.202688656234, 0.053169937665118905],
  [2485010253, -24202.124524542774, 4790.348884168511, 3.0009675992832543],
  [3520495928, -8923.18372940236, 20459.945533106165, 1.457375162799858],
  [1226657564, 13561.189586461605, -30518.81479563371, 1.2946881792746083],
  [2192300821, -18873.160485936747, 2531.7150555808676, 0.4015508784360602],
  [2305306137, -30763.898501114865, 1847.3141513149874, 0.4240669642897199],
  [2835411508, -26568.61258025533, -25437.514709698375, 3.004359336811646],
  [1125037555, -6726.418783304728, -14456.331599791612, 0.15060978408014059],
  [167635987, -25231.355999737214, 7458.965783827744, 1.6228620329241354],
  [2195444439, 14379.314225878381, -29855.25134789219, 1.272277665027036],
  [1724985344, -1168.8996789275889, 23969.38128952306, 2.217701418085708],
  [3882282490, 10675.137299575055, 4336.164579089735, 0.31867912357633665],
  [1897636936, 157.45897160599594, -14192.37034911886, 0.7790174217138546],
  [2728693428, 2599.2635476003047, 4600.902530966952, 2.1273790945183855],
  [2153470706, -21439.70031893987, 18852.859595968785, 3.0628542193030217],
  [1077965751, 25026.35740234024, 2585.5956797546005, 0.382534807375539],
  [677349074, -8895.605417884219, 6367.220332667098, 1.8228481276755115],
  [403077473, -8237.523249652912, -18974.490681503987, 2.972973590980443],
  [1860761274, 10257.185032531328, 19253.34780014083, 1.0852560533420808],
  [572585447, -23281.50390411304, -7257.377066291937, 1.4989057240745773],
  [1207454445, -20478.100419649378, 14475.727789215562, 2.1663760717568388],
  [3364751591, -8860.950027511957, -12542.079671709385, 0.6554967071633371],
  [4012960349, 10508.164505847399, 440.9630622952901, 2.0635727966865174],
  [439187847, 9676.597660505948, -16228.954446622267, 1.152245725724625],
  [199837455, 28423.891097607157, -1281.4411604155327, 2.942570703778299],
  [3819916473, 1544.0997496593072, 3598.951894370967, 3.1127210407312296],
  [3941163478, -25419.182053102206, -17607.750912331536, 2.9614531474761163],
  [2435218708, -2155.81993665671, 12237.293310977055, 0.7016879969444396],
  [3013585048, 10047.729723088509, 15353.885388339753, 1.6681221066420022],
  [1268289886, 9777.103516451285, -1264.6991122491702, 1.2155078821509129],
  [1585724385, 3581.6370895716796, -15400.705863922687, 1.3856502435123141],
  [1254950126, -7153.069048762203, 19513.727280874453, 1.9793199264825985],
  [910836107, 9857.245466039596, -22046.664222742154, 2.0177875355697354],
  [1924740333, 15792.05356164212, 16510.989324026006, 1.0286611602702984],
  [3199576400, 26220.42064015477, -18433.528063113736, 1.7401652250000477],
  [3407149201, 22450.659581686872, 697.195703211513, 3.00446525500894],
  [922221414, 14158.211667278327, -14562.207212580832, 1.502804412003587],
  [747615369, 6632.848122097606, 1872.9461819323758, 1.0978585057106063],
  [29564193, -23144.0200952989, 13932.445430549154, 1.6821719537680515],
  [3423632579, -17502.263873527878, 1821.8544700102702, 2.714705067441564],
  [3480135237, -27205.189061104596, 2440.8784935815943, 0.8524686050692765],
  [1256139291, 3609.463599841124, -829.6268385023843, 0.9102254437426698],
  [2687143572, 7281.41279596014, 6474.197567813709, 2.102031557258904],
  [1546894270, 5130.233189253688, -1471.8887211166723, 2.6545606998806615],
  [3739112625, -9917.389170797873, 16265.018712742862, 2.223537184981189],
  [718981396, -22103.48008193792, -13777.619705355382, 1.0327956527701962],
  [2776612986, 26335.209798982283, -17371.014049890702, 1.5522614979765867],
  [1531600057, 28965.90338722363, 5065.922118025315, 1.4598028127723772],
  [2932781200, 26113.874354118405, -12612.215173086017, 1.0653836602700517],
  [652282596, -7655.349487032367, -21924.17323899806, 2.1392113475508436],
  [3067367965, -26065.702873629227, 1159.470607046064, 1.681029554084544],
  [1722689480, 8023.093728135836, -14643.626153959562, 0.22001147976275615],
  [3610813096, 33366.38341365302, -622.6441675940786, 2.079263993919888],
  [3653975994, 23096.419951660795, -10130.547516371531, 2.814306969261633],
  [1443319808, -29119.583208304888, -12474.369962238721, 2.8163726816367536],
  [3831725657, -26530.396570553312, -12071.506206113341, 0.6935134771531937],
  [3888228315, 25384.462281042775, -1570.0088751926119, 3.0320204610338752],
  [2982231334, 13799.086110586624, 19878.35974464356, 1.4373859850786674],
  [2385427163, -25267.948493836702, -20727.90101270684, 1.544001048195418],
  [3646923470, 12110.242560296234, 9097.991547248394, 1.3960932903144845],
  [3816431444, -7709.5260926262135, -7090.638971329167, 2.23191463275172],
  [296017982, 13708.505371144836, 3317.296541676562, 2.993290242064577],
  [3894515551, -10639.322782418973, 3611.7912011577405, 2.3549183405258027],
  [3723053124, -25796.6583885117, 2920.803567021778, 1.3508785127931944],
  [719405273, -33230.52827148857, 732.7648317349385, 2.8766776306635418],
  [1962463749, 29512.37122931198, -3165.9315744535074, 2.4175189296417248],
  [1335836440, -12725.088741214244, 3867.603552580376, 1.4907475692656948],
  [2758599032, 6404.813898762734, -23293.040858019544, 2.8755414694557837],
  [3471552137, 7320.818581403737, 1404.0217887064698, 0.03853153682628374],
  [1852602051, 24431.589473344982, 3003.5304808441847, 1.280906993500576],
  [3275364643, 19965.493541348074, 2953.142222608398, 2.6657008936906657],
  [1304058849, -6229.3240330649205, -13819.726881141512, 1.2831091774830572],
  [2277943795, 6302.025672998376, -5869.473166524243, 1.9316797660949998],
  [3974977988, -932.0885596826454, 13613.242887122819, 1.6869422232112603],
  [828501683, -13812.06668051728, 5111.503984466685, 2.048570703715519],
  [3983219677, 13859.759413336342, -15452.628850649633, 2.939423893148165],
  [1385286574, -18391.585114922756, 17117.744125643047, 0.27468548369211465],
  [1845549527, -11228.45340023558, -26291.135128898066, 1.1350925288090155],
  [761802883, 26645.88998059803, -18424.088857191582, 2.4215550645437522],
  [1832209767, -321.254847495108, 2882.5179505081496, 0.8948132673180447],
  [3973023535, 3983.4522664662095, 9504.663161625669, 0.5809207691514615],
  [3150208732, -8220.9343414114, 21761.176638769528, 1.415833448432033],
  [2806094713, -28011.297027852623, 2669.6854283402954, 0.7580003293219724],
  [926212786, -7826.369868936946, 23349.454160405712, 1.549929504586423],
  [1996619670, 13671.418427741273, -19005.940670730797, 0.11625962350858732],
  [2357217067, 11102.885431261599, -32373.343502147065, 1.7085770501550597],
  [237984748, 8088.408974173286, -12965.575274456476, 0.2763497571285414],
  [3414284191, 9194.748310770752, -18601.40293357484, 0.022839972008088072],
  [3091751621, -12357.423006924299, -30046.394172304073, 3.034506110179906],
  [1050603409, -30400.014919871755, 3108.6652294894175, 2.999724207556989],
  [776331808, -26890.840201590432, -13102.320156001966, 2.240442561551328],
  [262709815, -9391.286045414245, -1220.9975545534753, 3.133713356334007],
  [123024979, 24426.324158070605, -2136.0768147767735, 0.9880872840729724],
  [3181221035, -11171.585655930236, 4128.706546385965, 0.025799996913430157],
  [3646582059, 5549.468325851141, -24053.64765734616, 2.919389415030147],
  [3119620306, -14532.125118483178, 11827.135616489604, 2.7482584065081674],
  [3324049489, 15086.42117887028, 9796.52313191031, 1.6565865708306673],
  [1113393303, -9330.816183197729, 21051.01315796483, 2.534481372739487],
  [586431550, -11210.299902096374, -18539.413821697934, 1.5698715585881553],
  [150893664, 11814.503860436376, 32072.13767624319, 2.2819947717276685],
  [2791989665, 0, 0, 1.3629175987828983],
  [2999562466, -2131.887526208077, -7081.476740816524, 0.10866135323613468],
  [1437115038, 13271.391339205318, -27794.698653044543, 1.6037038138972868],
  [2986222706, -8609.35543428407, 1765.377450220465, 1.4563386628063988],
  [3747436780, 9254.858742888586, -2823.801944644907, 1.7383803514462677],
  [509536608, 3327.204203691089, 19490.21945254435, 0.4258625708418906],
  [30835824, -13973.244478648141, -2205.3723228715608, 1.3274629722834494],
  [3995028861, 10100.705891605296, 8412.053757533029, 0.05838547601228683],
  [3115711400, -14487.811373133565, -23997.241077171544, 0.5925546066663974],
  [905055214, -8234.146907535936, 23104.816299523518, 2.9732979067523537],
  [687286271, -3541.129287769694, -3008.002644278329, 1.2919267240741186],
  [2131630312, -6801.692045355524, 404.75559003379857, 1.7440760582441532],
  [1413579136, -8.653840642028413, -18996.503531281494, 1.9137251664199857],
  [1599570488, 11167.94653770433, 22557.360449764008, 1.1817260441130744],
  [1742398942, 25395.4310306308, -10223.276595929983, 1.2000054085602319],
  [397720457, 11453.636158560459, -19938.96047791216, 1.49804104935692],
  [2207759966, 3297.8673258249114, 624.7468282816592, 3.059860825901075],
  [3151821774, 9934.608949800919, -17123.329473677168, 1.6300562167386046],
  [4060962373, -22873.31054756611, -13914.493524622556, 1.720873165413927],
  [857983410, -26183.86079766474, 5275.660449132856, 1.489885060854201],
  [2998797178, -24396.779200983023, 28014.26436580394, 1.7285155239358954],
  [2323908900, -8479.250308359487, -20962.61160948306, 1.6556404611193594],
  [591953498, 9131.332349922925, 3778.7004056383594, 1.6281153403643085],
  [1810286907, 14115.128398018502, -13369.584104897329, 3.095658801883353],
  [2353732038, 29486.224880164013, -397.8448125879876, 1.3346921557590425],
  [4201836374, 7385.76769524764, 25382.301750781327, 0.5584222070187002],
  [2434959763, 25498.428541976926, 3382.175490016944, 1.48494469436854],
  [555077836, 10321.625830654917, -18006.599108740098, 2.8897546841217965],
  [3561869305, 15189.85521198447, 10478.265892345042, 2.8965644650972058],
  [1316291910, 24734.245835162616, -10048.059802891961, 0.9941241193827244],
  [1690229067, 8474.118178768598, 696.6006267037608, 0.6286134938707484],
  [3395504949, 20976.860270470952, 25312.769751620766, 0.7564677119737366],
  [636305561, -13555.11506433677, 9888.465447595665, 2.9164614145278636],
  [2389842412, 17186.971958584163, -1147.030792440222, 2.8575656056091434],
  [4199881921, 440.66352100227266, -22794.64242468736, 0.38307991259053686],
  [2285078785, -25997.768321969892, -8914.077526635016, 1.7563535698731654],
  [1349258666, 16220.819123182397, 6966.574401655344, 1.4966347843637315],
  [1309239386, -23599.109717337684, 21864.11977919556, 1.8469886605325367],
] as const satisfies readonly SafeFlightRegionTuple[];

interface CoarseCandidate {
  readonly centerX: number;
  readonly centerZ: number;
  readonly gradientX: number;
  readonly gradientZ: number;
  readonly score: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PRIMARY_CANDIDATE_COUNT = 192;
/**
 * Detailed candidates examined per search. EXPORTED so `world.test.ts` can
 * derive its work ceiling from the search's own constant rather than from a
 * number copied out of a passing run — a budget that does not move when the
 * search does is decorative.
 */
export const DETAILED_PRIMARY_COUNT = 192;

/**
 * Headings tried per detailed candidate: the contour, the contour + 45 deg,
 * and the preferred heading (`findDetailedCandidate`). Exported for the same
 * reason as the count above.
 */
export const HEADINGS_PER_DETAILED_CANDIDATE = 3;
const DRY_PLATFORM_CLEARANCE = 8;
// These describe the untouched ground, not the finished pavement. A site may
// be technically gradeable yet still look like an implausible mountain cut in
// a low-altitude fly-by. Keep the accepted envelope deliberately conservative
// and return no airport when the bounded search cannot satisfy it.
const MAX_PLATFORM_RELIEF = 24;
const MAX_LONGITUDINAL_GRADE = 0.065;
const MAX_CROSS_GRADE = 0.12;
const MAX_BLEND_RELIEF = 50;
const MAX_AIRPORT_ELEVATION = 260;
const SITE_CACHE_LIMIT = 24;
const siteCache = new Map<string, GeneratedAirportSite | null>();
const CATALOGUE_CACHE_LIMIT = 256;
const catalogueSiteCache = new Map<string, GeneratedAirportSite | null>();

function cacheKey(
  seedHash: number,
  seaLevel: number,
  footprint: Readonly<AirportFootprint>,
  preferredHeading: number,
): string {
  return [
    seedHash >>> 0,
    seaLevel,
    footprint.runwayLength,
    footprint.runwayWidth,
    footprint.endSafetyArea,
    footprint.shoulderWidth,
    footprint.terrainBlendDistance,
    preferredHeading,
  ].join(":");
}

function rememberSite(key: string, site: GeneratedAirportSite | null): GeneratedAirportSite | null {
  if (siteCache.size >= SITE_CACHE_LIMIT) {
    const oldest = siteCache.keys().next().value as string | undefined;
    if (oldest !== undefined) siteCache.delete(oldest);
  }
  siteCache.set(key, site);
  return site;
}

function pointAt(
  centerX: number,
  centerZ: number,
  headingRadians: number,
  along: number,
  across: number,
): readonly [number, number] {
  const sinHeading = Math.sin(headingRadians);
  const cosHeading = Math.cos(headingRadians);
  return [
    centerX + along * sinHeading + across * cosHeading,
    centerZ + along * cosHeading - across * sinHeading,
  ];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length * 0.5);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) * 0.5
    : (sorted[middle] ?? 0);
}

interface PlatformAssessment {
  readonly elevation: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly relief: number;
  readonly longitudinalGrade: number;
  readonly crossGrade: number;
}

interface BlendAssessment {
  readonly minimum: number;
  readonly maximum: number;
  readonly relief: number;
}

interface ApproachAssessment {
  readonly minimumHeight: number;
  readonly obstruction: number;
}

interface CertificationResolution {
  readonly platformAlong: number;
  readonly platformAcross: number;
  readonly blend: number;
  readonly approachAlong: number;
  readonly approachAcross: number;
}

const INTERMEDIATE_CERTIFICATION = Object.freeze({
  platformAlong: 72,
  platformAcross: 31,
  blend: 64,
  approachAlong: 128,
  approachAcross: 96,
} satisfies CertificationResolution);

// The natural-height kernel contains a 43 m soil band. The final footprint
// lattice stays below half that wavelength on constructed ground, while the
// approach lattice is paired with a conservative clearance margin below.
const FINAL_CERTIFICATION = Object.freeze({
  platformAlong: 12,
  platformAcross: 10,
  blend: 14,
  approachAlong: 32,
  approachAcross: 32,
} satisfies CertificationResolution);

const LONGITUDINAL_GRADE_BASELINE = 160;
const CERTIFIED_PLATFORM_CLEARANCE = 9;
const CERTIFIED_BLEND_CLEARANCE = 3;
const CERTIFIED_PLATFORM_RELIEF = 24;
const CERTIFIED_BLEND_RELIEF = 48;
const CERTIFIED_LONGITUDINAL_GRADE = 0.062;
const CERTIFIED_CROSS_GRADE = 0.11;
const CERTIFIED_APPROACH_CLEARANCE = 3;
const CERTIFIED_APPROACH_OBSTRUCTION = -6;

function axisSamples(minimum: number, maximum: number, maximumSpacing: number): number[] {
  const extent = Math.max(0, maximum - minimum);
  const intervals = Math.max(1, Math.ceil(extent / maximumSpacing));
  return Array.from(
    { length: intervals + 1 },
    (_, index) => minimum + (extent * index) / intervals,
  );
}

function roundedPlatformDistance(
  along: number,
  across: number,
  halfLength: number,
  halfWidth: number,
): number {
  const qAlong = Math.abs(along) - halfLength;
  const qAcross = Math.abs(across) - halfWidth;
  return (
    Math.hypot(Math.max(qAlong, 0), Math.max(qAcross, 0)) +
    Math.min(Math.max(qAlong, qAcross), 0)
  );
}

function sampleCertifiedFootprint(
  seedHash: number,
  seaLevel: number,
  centerX: number,
  centerZ: number,
  headingRadians: number,
  footprint: Readonly<AirportFootprint>,
  resolution: Readonly<CertificationResolution>,
  rejectEarly: boolean,
): AirportSiteAssessment | null {
  const halfPlatformLength = footprint.runwayLength * 0.5 + footprint.endSafetyArea;
  const halfPlatformWidth = footprint.runwayWidth * 0.5 + footprint.shoulderWidth;
  const platformAlong = axisSamples(
    -halfPlatformLength,
    halfPlatformLength,
    resolution.platformAlong,
  );
  const platformAcross = axisSamples(
    -halfPlatformWidth,
    halfPlatformWidth,
    resolution.platformAcross,
  );
  const platformRows: number[][] = [];
  const platformHeights: number[] = [];
  let platformMinimum = Number.POSITIVE_INFINITY;
  let platformMaximum = Number.NEGATIVE_INFINITY;

  for (const along of platformAlong) {
    const row: number[] = [];
    for (const across of platformAcross) {
      const [x, z] = pointAt(centerX, centerZ, headingRadians, along, across);
      const height = sampleNaturalTerrainHeight(seedHash, x, z, 0);
      row.push(height);
      platformHeights.push(height);
      platformMinimum = Math.min(platformMinimum, height);
      platformMaximum = Math.max(platformMaximum, height);
      if (
        rejectEarly &&
        (platformMinimum < seaLevel + CERTIFIED_PLATFORM_CLEARANCE ||
          platformMaximum - platformMinimum > CERTIFIED_PLATFORM_RELIEF)
      ) {
        return null;
      }
    }
    platformRows.push(row);
  }

  const elevation = median(platformHeights);
  const platformRelief = platformMaximum - platformMinimum;
  const actualAlongSpacing =
    (halfPlatformLength * 2) / Math.max(1, platformAlong.length - 1);
  const gradeLag = Math.max(1, Math.ceil(LONGITUDINAL_GRADE_BASELINE / actualAlongSpacing));
  const gradeDistance = actualAlongSpacing * gradeLag;
  let longitudinalGrade = 0;
  let crossGrade = 0;
  for (let rowIndex = 0; rowIndex < platformRows.length; rowIndex += 1) {
    const row = platformRows[rowIndex]!;
    crossGrade = Math.max(
      crossGrade,
      Math.abs((row.at(-1) ?? elevation) - (row[0] ?? elevation)) /
        Math.max(1, halfPlatformWidth * 2),
    );
    const previousRow = platformRows[rowIndex - gradeLag];
    if (!previousRow) continue;
    for (let acrossIndex = 0; acrossIndex < row.length; acrossIndex += 1) {
      longitudinalGrade = Math.max(
        longitudinalGrade,
        Math.abs((row[acrossIndex] ?? elevation) - (previousRow[acrossIndex] ?? elevation)) /
          gradeDistance,
      );
    }
  }
  if (
    rejectEarly &&
    (elevation > seaLevel + MAX_AIRPORT_ELEVATION ||
      longitudinalGrade > CERTIFIED_LONGITUDINAL_GRADE ||
      crossGrade > CERTIFIED_CROSS_GRADE)
  ) {
    return null;
  }

  const blendExtentAlong = halfPlatformLength + footprint.terrainBlendDistance;
  const blendExtentAcross = halfPlatformWidth + footprint.terrainBlendDistance;
  const blendAlong = axisSamples(-blendExtentAlong, blendExtentAlong, resolution.blend);
  const blendAcross = axisSamples(-blendExtentAcross, blendExtentAcross, resolution.blend);
  let blendMinimum = platformMinimum;
  let blendMaximum = platformMaximum;
  for (const along of blendAlong) {
    for (const across of blendAcross) {
      if (
        roundedPlatformDistance(along, across, halfPlatformLength, halfPlatformWidth) >
        footprint.terrainBlendDistance
      ) {
        continue;
      }
      const [x, z] = pointAt(centerX, centerZ, headingRadians, along, across);
      const height = sampleNaturalTerrainHeight(seedHash, x, z, 0);
      blendMinimum = Math.min(blendMinimum, height);
      blendMaximum = Math.max(blendMaximum, height);
      if (
        rejectEarly &&
        (blendMinimum < seaLevel + CERTIFIED_BLEND_CLEARANCE ||
          blendMaximum - blendMinimum > CERTIFIED_BLEND_RELIEF)
      ) {
        return null;
      }
    }
  }

  let minimumApproachHeight = Number.POSITIVE_INFINITY;
  let approachObstruction = Number.NEGATIVE_INFINITY;
  const approachDistances = axisSamples(0, 4_200, resolution.approachAlong);
  for (const end of [-1, 1]) {
    for (const distance of approachDistances) {
      const corridorHalfWidth = 70 + distance * 0.095;
      const acrossSamples = axisSamples(
        -corridorHalfWidth,
        corridorHalfWidth,
        resolution.approachAcross,
      );
      const permittedHeight = elevation + 18 + distance * 0.0524;
      for (const across of acrossSamples) {
        const along = end * (halfPlatformLength + distance);
        const [x, z] = pointAt(centerX, centerZ, headingRadians, along, across);
        const height = sampleNaturalTerrainHeight(seedHash, x, z, 0);
        if (distance <= 520) {
          minimumApproachHeight = Math.min(minimumApproachHeight, height);
          if (
            rejectEarly &&
            minimumApproachHeight < seaLevel + CERTIFIED_APPROACH_CLEARANCE
          ) {
            return null;
          }
        }
        approachObstruction = Math.max(approachObstruction, height - permittedHeight);
        if (rejectEarly && approachObstruction > CERTIFIED_APPROACH_OBSTRUCTION) return null;
      }
    }
  }

  const platform = {
    elevation,
    minimum: platformMinimum,
    maximum: platformMaximum,
    relief: platformRelief,
    longitudinalGrade,
    crossGrade,
  } satisfies PlatformAssessment;
  const blend = {
    minimum: blendMinimum,
    maximum: blendMaximum,
    relief: blendMaximum - blendMinimum,
  } satisfies BlendAssessment;
  const approaches = {
    minimumHeight: minimumApproachHeight,
    obstruction: approachObstruction,
  } satisfies ApproachAssessment;
  const assessment = buildAssessment(seaLevel, platform, blend, approaches);
  const suitable =
    assessment.suitable &&
    assessment.minimumPlatformClearance >= CERTIFIED_PLATFORM_CLEARANCE &&
    assessment.platformRelief <= CERTIFIED_PLATFORM_RELIEF &&
    assessment.longitudinalGrade <= CERTIFIED_LONGITUDINAL_GRADE &&
    assessment.crossGrade <= CERTIFIED_CROSS_GRADE &&
    blend.minimum >= seaLevel + CERTIFIED_BLEND_CLEARANCE &&
    assessment.blendRelief <= CERTIFIED_BLEND_RELIEF &&
    assessment.minimumApproachClearance >= CERTIFIED_APPROACH_CLEARANCE &&
    assessment.approachObstruction <= CERTIFIED_APPROACH_OBSTRUCTION;
  if (rejectEarly && !suitable) return null;
  return suitable === assessment.suitable
    ? assessment
    : Object.freeze({ ...assessment, suitable });
}

function samplePlatform(
  seedHash: number,
  seaLevel: number,
  centerX: number,
  centerZ: number,
  headingRadians: number,
  footprint: Readonly<AirportFootprint>,
  rejectEarly: boolean,
): PlatformAssessment | null {
  const halfPlatformLength = footprint.runwayLength * 0.5 + footprint.endSafetyArea;
  const halfPlatformWidth = footprint.runwayWidth * 0.5 + footprint.shoulderWidth;
  const alongSpacing = (halfPlatformLength * 2) / 8;
  const acrossSpacing = Math.max(1, halfPlatformWidth * 2);
  const platformRows: number[][] = [];
  const platformHeights: number[] = [];
  let platformMinimum = Number.POSITIVE_INFINITY;
  let platformMaximum = Number.NEGATIVE_INFINITY;
  let longitudinalGrade = 0;
  let crossGrade = 0;

  // At ~185 m spacing this resolves the terrain kernel's 310 m fine octave;
  // a five-point check could step over an entire wet depression between probes.
  for (let alongIndex = 0; alongIndex < 9; alongIndex += 1) {
    const along = -halfPlatformLength + alongIndex * alongSpacing;
    const row: number[] = [];
    for (const across of [-halfPlatformWidth, 0, halfPlatformWidth]) {
      const [x, z] = pointAt(centerX, centerZ, headingRadians, along, across);
      const height = sampleNaturalTerrainHeight(seedHash, x, z, 0);
      if (rejectEarly && height < seaLevel + DRY_PLATFORM_CLEARANCE) return null;
      row.push(height);
      platformHeights.push(height);
      platformMinimum = Math.min(platformMinimum, height);
      platformMaximum = Math.max(platformMaximum, height);
      if (rejectEarly && platformMaximum - platformMinimum > MAX_PLATFORM_RELIEF) return null;
    }
    crossGrade = Math.max(
      crossGrade,
      Math.abs((row[2] ?? 0) - (row[0] ?? 0)) / acrossSpacing,
    );
    if (rejectEarly && crossGrade > MAX_CROSS_GRADE) return null;
    const previousCenter = platformRows.at(-1)?.[1];
    if (previousCenter !== undefined) {
      longitudinalGrade = Math.max(
        longitudinalGrade,
        Math.abs((row[1] ?? 0) - previousCenter) / alongSpacing,
      );
      if (rejectEarly && longitudinalGrade > MAX_LONGITUDINAL_GRADE) return null;
    }
    platformRows.push(row);
  }

  const elevation = median(platformHeights);
  const relief = platformMaximum - platformMinimum;
  if (
    rejectEarly &&
    (elevation > seaLevel + MAX_AIRPORT_ELEVATION ||
      relief > MAX_PLATFORM_RELIEF ||
      longitudinalGrade > MAX_LONGITUDINAL_GRADE ||
      crossGrade > MAX_CROSS_GRADE)
  ) {
    return null;
  }
  return { elevation, minimum: platformMinimum, maximum: platformMaximum, relief, longitudinalGrade, crossGrade };
}

function sampleBlend(
  seedHash: number,
  seaLevel: number,
  centerX: number,
  centerZ: number,
  headingRadians: number,
  footprint: Readonly<AirportFootprint>,
  platform: Readonly<PlatformAssessment>,
  rejectEarly: boolean,
): BlendAssessment | null {
  const halfPlatformLength = footprint.runwayLength * 0.5 + footprint.endSafetyArea;
  const halfPlatformWidth = footprint.runwayWidth * 0.5 + footprint.shoulderWidth;
  const blendLength = halfPlatformLength + footprint.terrainBlendDistance;
  const blendWidth = halfPlatformWidth + footprint.terrainBlendDistance;
  let minimum = platform.minimum;
  let maximum = platform.maximum;
  for (const along of [-blendLength, -blendLength * 0.5, 0, blendLength * 0.5, blendLength]) {
    for (const across of [-blendWidth, 0, blendWidth]) {
      const [x, z] = pointAt(centerX, centerZ, headingRadians, along, across);
      const height = sampleNaturalTerrainHeight(seedHash, x, z, 0);
      minimum = Math.min(minimum, height);
      maximum = Math.max(maximum, height);
      if (
        rejectEarly &&
        (minimum < seaLevel + 2 || maximum - minimum > MAX_BLEND_RELIEF)
      ) {
        return null;
      }
    }
  }
  return { minimum, maximum, relief: maximum - minimum };
}

function sampleApproaches(
  seedHash: number,
  seaLevel: number,
  centerX: number,
  centerZ: number,
  headingRadians: number,
  footprint: Readonly<AirportFootprint>,
  elevation: number,
  rejectEarly: boolean,
): ApproachAssessment | null {
  const halfPlatformLength = footprint.runwayLength * 0.5 + footprint.endSafetyArea;
  let obstruction = Number.NEGATIVE_INFINITY;
  let minimumHeight = Number.POSITIVE_INFINITY;
  const approachDistances = [240, 520, 940, 1_500, 2_250, 3_100, 4_200];
  for (const end of [-1, 1]) {
    for (const distance of approachDistances) {
      const corridorHalfWidth = 70 + distance * 0.095;
      const permittedHeight = elevation + 18 + distance * 0.0524;
      for (const across of [-corridorHalfWidth, 0, corridorHalfWidth]) {
        const along = end * (halfPlatformLength + distance);
        const [x, z] = pointAt(centerX, centerZ, headingRadians, along, across);
        const height = sampleNaturalTerrainHeight(seedHash, x, z, 0);
        if (distance <= 520) {
          minimumHeight = Math.min(minimumHeight, height);
          if (rejectEarly && minimumHeight < seaLevel + 2) return null;
        }
        obstruction = Math.max(obstruction, height - permittedHeight);
        if (rejectEarly && obstruction > 0) return null;
      }
    }
  }
  return { minimumHeight, obstruction };
}

function buildAssessment(
  seaLevel: number,
  platform: Readonly<PlatformAssessment>,
  blend: Readonly<BlendAssessment>,
  approaches: Readonly<ApproachAssessment>,
): AirportSiteAssessment {
  const minimumPlatformClearance = platform.minimum - seaLevel;
  const minimumApproachClearance = approaches.minimumHeight - seaLevel;
  const suitable =
    minimumPlatformClearance >= DRY_PLATFORM_CLEARANCE &&
    blend.minimum >= seaLevel + 2 &&
    platform.elevation <= seaLevel + MAX_AIRPORT_ELEVATION &&
    platform.relief <= MAX_PLATFORM_RELIEF &&
    platform.longitudinalGrade <= MAX_LONGITUDINAL_GRADE &&
    platform.crossGrade <= MAX_CROSS_GRADE &&
    blend.relief <= MAX_BLEND_RELIEF &&
    minimumApproachClearance >= 2 &&
    approaches.obstruction <= 0;
  const score =
    Math.max(0, DRY_PLATFORM_CLEARANCE - minimumPlatformClearance) * 240 +
    Math.max(0, seaLevel + 2 - blend.minimum) * 180 +
    Math.max(0, 2 - minimumApproachClearance) * 90 +
    platform.relief * 7 +
    platform.longitudinalGrade * 1_400 +
    platform.crossGrade * 360 +
    blend.relief * 1.8 +
    Math.max(0, approaches.obstruction) * 12 +
    Math.max(0, platform.elevation - (seaLevel + 220)) * 0.75;
  return Object.freeze({
    elevation: platform.elevation,
    minimumPlatformClearance,
    platformRelief: platform.relief,
    longitudinalGrade: platform.longitudinalGrade,
    crossGrade: platform.crossGrade,
    blendRelief: blend.relief,
    minimumApproachClearance,
    approachObstruction: approaches.obstruction,
    suitable,
    score,
  });
}

/**
 * Evaluates the untouched terrain, never the already-flattened airport sample.
 * This distinction prevents a constructed runway from "proving" its own site
 * is dry and level after it has replaced an ocean or cut through a mountain.
 */
/**
 * Site assessments performed since the last reset — the search's WORK, counted.
 *
 * `world.test.ts`'s 384-seed sweep used to guard site selection with a
 * wall-clock p95, under a comment stating it guarded "an algorithmic
 * regression ... not hardware speed". It did the opposite: the budget was
 * calibrated per machine, drifted with load, and failed and passed on
 * identical code twenty minutes apart. Counting the assessments measures the
 * property the comment claims — an unbounded or badly seeded search does more
 * of them — and is exactly reproducible, because the search is a pure function
 * of the seed with no clock, no concurrency and no allocation sensitivity.
 */
let airportSiteEvaluationCount = 0;

/** Reads the evaluation counter. Test-only; nothing in the renderer calls it. */
export function readAirportSiteEvaluationCount(): number {
  return airportSiteEvaluationCount;
}

/** Resets the evaluation counter. Test-only. */
export function resetAirportSiteEvaluationCount(): void {
  airportSiteEvaluationCount = 0;
}

export function assessAirportSite(
  seedHash: number,
  seaLevel: number,
  centerX: number,
  centerZ: number,
  headingRadians: number,
  footprint: Readonly<AirportFootprint>,
): AirportSiteAssessment {
  airportSiteEvaluationCount += 1;
  return sampleCertifiedFootprint(
    seedHash,
    seaLevel,
    centerX,
    centerZ,
    headingRadians,
    footprint,
    FINAL_CERTIFICATION,
    false,
  )!;
}

function assessSuitableAirportSite(
  seedHash: number,
  seaLevel: number,
  centerX: number,
  centerZ: number,
  headingRadians: number,
  footprint: Readonly<AirportFootprint>,
): AirportSiteAssessment | null {
  airportSiteEvaluationCount += 1;
  const platform = samplePlatform(
    seedHash,
    seaLevel,
    centerX,
    centerZ,
    headingRadians,
    footprint,
    true,
  );
  if (!platform) return null;
  const blend = sampleBlend(
    seedHash,
    seaLevel,
    centerX,
    centerZ,
    headingRadians,
    footprint,
    platform,
    true,
  );
  if (!blend) return null;
  const approaches = sampleApproaches(
    seedHash,
    seaLevel,
    centerX,
    centerZ,
    headingRadians,
    footprint,
    platform.elevation,
    true,
  );
  if (!approaches) return null;
  const sparseAssessment = buildAssessment(seaLevel, platform, blend, approaches);
  if (!sparseAssessment.suitable) return null;

  const intermediate = sampleCertifiedFootprint(
    seedHash,
    seaLevel,
    centerX,
    centerZ,
    headingRadians,
    footprint,
    INTERMEDIATE_CERTIFICATION,
    true,
  );
  if (!intermediate) return null;

  const certified = sampleCertifiedFootprint(
    seedHash,
    seaLevel,
    centerX,
    centerZ,
    headingRadians,
    footprint,
    FINAL_CERTIFICATION,
    true,
  );
  return certified;
}

function createCoarseCandidates(
  seedHash: number,
  seaLevel: number,
  count: number,
  startIndex: number,
): CoarseCandidate[] {
  const candidates: CoarseCandidate[] = [];
  const angleOffset = unitFloatFromHash(mixSeed(seedHash, 714)) * Math.PI * 2;
  const radialJitter = 0.82 + unitFloatFromHash(mixSeed(seedHash, 715)) * 0.36;

  for (let localIndex = 0; localIndex < count; localIndex += 1) {
    const index = startIndex + localIndex;
    // A denser low-discrepancy spiral searches actual buildable pockets near
    // the origin instead of jumping between widely separated mountain cells.
    const radius = index === 0 ? 0 : 1_150 * Math.sqrt(index) * radialJitter;
    const angle = angleOffset + index * GOLDEN_ANGLE;
    const centerX = Math.cos(angle) * radius;
    const centerZ = Math.sin(angle) * radius;
    const probeDistance = 820;
    const center = sampleNaturalTerrainHeight(seedHash, centerX, centerZ, 0);
    const west = sampleNaturalTerrainHeight(seedHash, centerX - probeDistance, centerZ, 0);
    const east = sampleNaturalTerrainHeight(seedHash, centerX + probeDistance, centerZ, 0);
    const south = sampleNaturalTerrainHeight(seedHash, centerX, centerZ - probeDistance, 0);
    const north = sampleNaturalTerrainHeight(seedHash, centerX, centerZ + probeDistance, 0);
    const minimum = Math.min(center, west, east, south, north);
    const maximum = Math.max(center, west, east, south, north);
    const relief = maximum - minimum;
    const dryPenalty = Math.max(0, seaLevel + 10 - minimum) * 260;
    const alpinePenalty = Math.max(0, center - (seaLevel + 220)) * 4;
    candidates.push({
      centerX,
      centerZ,
      gradientX: (east - west) / (probeDistance * 2),
      gradientZ: (north - south) / (probeDistance * 2),
      score: dryPenalty + alpinePenalty + relief * 3.4 + Math.max(0, center - seaLevel) * 0.025,
    });
  }

  return candidates.sort((left, right) => left.score - right.score);
}

function axisDifference(left: number, right: number): number {
  const difference = Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
  return Math.min(difference, Math.PI - difference);
}

function findDetailedCandidate(
  seedHash: number,
  seaLevel: number,
  footprint: Readonly<AirportFootprint>,
  preferredHeading: number,
  coarseCandidates: readonly CoarseCandidate[],
  limit: number,
): GeneratedAirportSite | null {
  const detailedCandidates = coarseCandidates.slice(0, limit);
  for (let candidateIndex = 0; candidateIndex < detailedCandidates.length; candidateIndex += 1) {
    const candidate = detailedCandidates[candidateIndex]!;
    // A contour-following runway minimizes grade. Wind alignment remains a
    // candidate too, but cannot override terrain and obstacle safety.
    const contourHeading = Math.atan2(candidate.gradientZ, -candidate.gradientX);
    const headings = [contourHeading, contourHeading + Math.PI * 0.25, preferredHeading];
    let bestSite: GeneratedAirportSite | null = null;
    for (const heading of headings) {
      const normalizedHeading = ((heading % Math.PI) + Math.PI) % Math.PI;
      const assessment = assessSuitableAirportSite(
        seedHash,
        seaLevel,
        candidate.centerX,
        candidate.centerZ,
        normalizedHeading,
        footprint,
      );
      if (!assessment) continue;
      // Crosswind is a tie-breaker after terrain work and obstacle clearance.
      const windPenalty = axisDifference(normalizedHeading, preferredHeading) * 4;
      const site = {
        centerX: candidate.centerX,
        centerZ: candidate.centerZ,
        headingRadians: normalizedHeading,
        assessment: Object.freeze({ ...assessment, score: assessment.score + windPenalty }),
      } satisfies GeneratedAirportSite;
      if (!bestSite || site.assessment.score < bestSite.assessment.score) bestSite = site;
    }
    // Coarse candidates are ordered by dryness, relief, and elevation. Once a
    // fully validated site exists, continuing through the whole region adds
    // latency but does not improve the safety contract.
    if (bestSite) return bestSite;
  }
  return null;
}

/**
 * Deterministically locates a buildable starter airport within one terrain
 * region. It may return null; createWorld resolves that case through the
 * independently validated flight-region catalogue rather than accepting the
 * least-bad unsafe site.
 */
export function findGeneratedAirportSite(
  seedHash: number,
  seaLevel: number,
  footprint: Readonly<AirportFootprint>,
  preferredHeading: number,
): GeneratedAirportSite | null {
  const key = cacheKey(seedHash, seaLevel, footprint, preferredHeading);
  if (siteCache.has(key)) return siteCache.get(key) ?? null;
  const primary = createCoarseCandidates(seedHash, seaLevel, PRIMARY_CANDIDATE_COUNT, 0);
  const primarySuitable = findDetailedCandidate(
    seedHash,
    seaLevel,
    footprint,
    preferredHeading,
    primary,
    DETAILED_PRIMARY_COUNT,
  );
  if (primarySuitable) return rememberSite(key, primarySuitable);
  return rememberSite(key, null);
}

function preferredHeadingForRegion(seedHash: number): number {
  return unitFloatFromHash(mixSeed(seedHash, 301)) * Math.PI * 2;
}

function generatedSiteAtCatalogueRegion(
  region: SafeFlightRegionTuple,
  seaLevel: number,
  footprint: Readonly<AirportFootprint>,
): GeneratedAirportSite | null {
  const [seedHash, centerX, centerZ, headingRadians] = region;
  const key = `catalogue:${cacheKey(seedHash, seaLevel, footprint, headingRadians)}`;
  if (catalogueSiteCache.has(key)) return catalogueSiteCache.get(key) ?? null;
  const assessment = assessAirportSite(
    seedHash,
    seaLevel,
    centerX,
    centerZ,
    headingRadians,
    footprint,
  );
  if (!assessment.suitable) {
    if (catalogueSiteCache.size >= CATALOGUE_CACHE_LIMIT) {
      const oldest = catalogueSiteCache.keys().next().value as string | undefined;
      if (oldest !== undefined) catalogueSiteCache.delete(oldest);
    }
    catalogueSiteCache.set(key, null);
    return null;
  }
  const windPenalty =
    axisDifference(headingRadians, preferredHeadingForRegion(seedHash)) * 4;
  const site = Object.freeze({
    centerX,
    centerZ,
    headingRadians,
    assessment: Object.freeze({ ...assessment, score: assessment.score + windPenalty }),
  });
  if (catalogueSiteCache.size >= CATALOGUE_CACHE_LIMIT) {
    const oldest = catalogueSiteCache.keys().next().value as string | undefined;
    if (oldest !== undefined) catalogueSiteCache.delete(oldest);
  }
  catalogueSiteCache.set(key, site);
  return site;
}

/**
 * Resolves a public seed to a terrain region that is guaranteed to contain a
 * fully assessed airport. The source terrain gets the first opportunity; a
 * hash-selected catalogue region is used only when the bounded live search
 * finds none. Catalogue entries are re-assessed at runtime, so threshold or
 * terrain-kernel changes fail closed instead of silently reviving unsafe cuts.
 */
export function resolveGuaranteedAirportRegion(
  sourceSeedHash: number,
  seaLevel: number,
  footprint: Readonly<AirportFootprint>,
): ResolvedAirportRegion {
  const sourceHash = sourceSeedHash >>> 0;
  const sourceSite = findGeneratedAirportSite(
    sourceHash,
    seaLevel,
    footprint,
    preferredHeadingForRegion(sourceHash),
  );
  if (sourceSite) {
    return Object.freeze({
      seedHash: sourceHash,
      site: sourceSite,
      usedFallbackRegion: false,
    });
  }

  const firstIndex = mixSeed(sourceHash, 917) % SAFE_FLIGHT_REGIONS.length;
  for (let offset = 0; offset < SAFE_FLIGHT_REGIONS.length; offset += 1) {
    const region = SAFE_FLIGHT_REGIONS[(firstIndex + offset) % SAFE_FLIGHT_REGIONS.length];
    if (!region) continue;
    const site = generatedSiteAtCatalogueRegion(region, seaLevel, footprint);
    if (!site) continue;
    return Object.freeze({
      seedHash: region[0],
      site,
      usedFallbackRegion: true,
    });
  }

  throw new Error(
    "No validated airport region supports the requested sea level and runway footprint",
  );
}
