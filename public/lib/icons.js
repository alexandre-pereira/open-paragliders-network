// Les pilotes sur les cartes du serveur : en vol, leur aile vue de dessus, nez vers leur route (la carte la tourne) ;
// au sol, debout ; en voiture, une voiture de profil ; les deux derniers toujours droits à l'écran. Mêmes dessins que
// l'appli WS Nav, remplis de la couleur du pilote sur un liseré blanc. Script classique : pilotIcon, pilotIconId,
// addPilotImages en global, pour les pages (couches MapLibre, marqueur du lien de suivi) et pour air3d.js (vue 3D).
'use strict';

/** pixels d'image par pixel CSS */
const ICON_PR = 2;
/** taille de dessin (px CSS) : les aéronefs font 28 à 31 px de large dans l'appli, ici un peu moins (une carte pleine) */
const ICON_BOX = 34;

/** « hsl(200 78% 45%) » plus sombre, pour les détails (cellules, vitres) */
const darker = css => css.replace(/(\d+)%\)$/, (_, l) => `${Math.max(0, Number(l) - 22)}%)`);

const ICON_SHAPES = {
  // la voile seule : bord d'attaque cintré vers l'avant, bouts en arrière, ses caissons
  paraglider(cx) {
    solid(cx, () => {
      cx.moveTo(-15, 3); cx.bezierCurveTo(-12, -4, -6, -6.5, 0, -6.5); cx.bezierCurveTo(6, -6.5, 12, -4, 15, 3);
      cx.quadraticCurveTo(15.6, 5.2, 13.5, 5.5); cx.bezierCurveTo(8, 3.6, -8, 3.6, -13.5, 5.5); cx.quadraticCurveTo(-15.6, 5.2, -15, 3); cx.closePath();
    });
    detail(cx, () => {
      for (const x of [-11, -7.5, -4, -0.5, 3, 6.5, 10]) {
        const xb = x * 0.93;
        cx.moveTo(x, -6.5 + 9.5 * (x / 15) ** 2 + 0.6); cx.lineTo(xb, 3.2 + 2.3 * (xb / 13.5) ** 2 - 0.4);
      }
    });
  },
  // delta : nez pointu, bord de fuite courbe échancré à la quille
  hangglider(cx) {
    solid(cx, () => {
      cx.moveTo(0, -13); cx.lineTo(15, 5); cx.lineTo(14, 7.5);
      cx.quadraticCurveTo(6, 2.5, 0, 5); cx.quadraticCurveTo(-6, 2.5, -14, 7.5); cx.lineTo(-15, 5); cx.closePath();
    });
    detail(cx, () => { cx.moveTo(0, -11); cx.lineTo(0, 4.5); });
  },
  // planeur : longues ailes fines bien en avant, fuselage mince, petit empennage
  sailplane(cx) {
    solid(cx, () => {
      cx.moveTo(0, -11.5); cx.quadraticCurveTo(2.6, -10, 2.3, -5); cx.lineTo(0.9, 11); cx.lineTo(-0.9, 11); cx.lineTo(-2.3, -5); cx.quadraticCurveTo(-2.6, -10, 0, -11.5); cx.closePath();
      cx.moveTo(-15.5, -3.6); cx.lineTo(0, -5); cx.lineTo(15.5, -3.6); cx.lineTo(15.5, -2.2); cx.lineTo(0, -1.2); cx.lineTo(-15.5, -2.2); cx.closePath();
      cx.rect(-4.5, 9, 9, 2);
    });
  },
  // autre : un cerf-volant pointé vers sa route
  other(cx) { solid(cx, () => { cx.moveTo(0, -10); cx.lineTo(6.5, 1); cx.lineTo(0, 8); cx.lineTo(-6.5, 1); cx.closePath(); }); },
  // au sol : debout, tête et membres sur un même liseré
  foot(cx) {
    const limbs = () => { cx.moveTo(0, -3); cx.lineTo(0, 4.5); cx.moveTo(-5.5, 4); cx.lineTo(0, -2.2); cx.lineTo(5.5, 4); cx.moveTo(-4, 12.5); cx.lineTo(0, 4.5); cx.lineTo(4, 12.5); };
    const head = () => { cx.moveTo(3.4, -8.5); cx.arc(0, -8.5, 3.4, 0, Math.PI * 2); };
    cx.lineCap = 'round'; cx.strokeStyle = '#fff';
    cx.lineWidth = 5.6; cx.beginPath(); limbs(); cx.stroke();
    cx.lineWidth = 3; cx.beginPath(); head(); cx.stroke();
    cx.lineWidth = 2.6; cx.strokeStyle = cx.fillStyle; cx.beginPath(); limbs(); cx.stroke();
    cx.beginPath(); head(); cx.fill();
  },
  // en voiture : vue de profil, vitres et moyeux
  car(cx) {
    solid(cx, () => {
      cx.moveTo(-13, 5); cx.lineTo(-13, 0); cx.quadraticCurveTo(-13, -2.2, -10, -2.6); cx.lineTo(-7, -3); cx.lineTo(-4, -8.5);
      cx.lineTo(5, -8.5); cx.lineTo(8.5, -3); cx.lineTo(12, -2.5); cx.quadraticCurveTo(13.5, -2, 13.5, 1); cx.lineTo(13.5, 5); cx.closePath();
      cx.moveTo(-4.3, 5.5); cx.arc(-7.5, 5.5, 3.2, 0, Math.PI * 2);
      cx.moveTo(11.2, 5.5); cx.arc(8, 5.5, 3.2, 0, Math.PI * 2);
    });
    detail(cx, () => {
      cx.moveTo(-5.6, -3.4); cx.lineTo(-3.3, -7.2); cx.lineTo(0.2, -7.2); cx.lineTo(0.2, -3.4); cx.closePath();
      cx.moveTo(1.4, -3.4); cx.lineTo(1.4, -7.2); cx.lineTo(4.4, -7.2); cx.lineTo(6.9, -3.4); cx.closePath();
      cx.moveTo(-6.3, 5.5); cx.arc(-7.5, 5.5, 1.2, 0, Math.PI * 2);
      cx.moveTo(9.2, 5.5); cx.arc(8, 5.5, 1.2, 0, Math.PI * 2);
    });
  },
};

/** une partie pleine sur son liseré blanc (le liseré d'abord : il ne mord jamais sur la partie) */
function solid(cx, path) { cx.beginPath(); path(); cx.lineJoin = 'round'; cx.lineWidth = 3; cx.strokeStyle = '#fff'; cx.stroke(); cx.fill(); }
function detail(cx, path) { cx.beginPath(); path(); cx.lineWidth = 0.8; cx.strokeStyle = cx.detailInk; cx.stroke(); }

/** « air » (en vol), « foot » (au sol), « car » (en voiture) → le dessin ; en vol selon le type d'aéronef du profil */
const shapeOf = (kind, type) => (kind === 'air' ? (ICON_SHAPES[type] ? type : type === 'paramotor' ? 'paraglider' : type ? 'other' : 'paraglider') : kind === 'car' ? 'car' : 'foot');

const iconCache = new Map();
/** l'image d'un pilote (canvas de ICON_BOX × ICON_PR px) ; sel : un peu plus grand */
function pilotIcon(kind, type, color, sel = false) {
  const key = pilotIconId(kind, type, color, sel);
  let c = iconCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = ICON_BOX * ICON_PR;
  const cx = c.getContext('2d');
  cx.scale(ICON_PR, ICON_PR); cx.translate(ICON_BOX / 2, ICON_BOX / 2);
  if (!sel) cx.scale(0.85, 0.85);
  cx.fillStyle = color; cx.detailInk = darker(color);
  ICON_SHAPES[shapeOf(kind, type)](cx);
  iconCache.set(key, c);
  return c;
}

/** le nom de l'image dans le style MapLibre : « pilot|air|paraglider|hsl(…)|1 » */
function pilotIconId(kind, type, color, sel) { return ['pilot', kind, shapeOf(kind, type), color, sel ? 1 : 0].join('|'); }

/** les images des pilotes, faites à la demande quand une couche en réclame une (« pilot|… ») */
function addPilotImages(map) {
  map.on('styleimagemissing', e => {
    const [pre, kind, shape, color, sel] = String(e.id).split('|');
    if (pre !== 'pilot' || map.hasImage(e.id)) return;
    const c = pilotIcon(kind, kind === 'air' ? shape : undefined, color, sel === '1');
    map.addImage(e.id, c.getContext('2d').getImageData(0, 0, c.width, c.height), { pixelRatio: ICON_PR });
  });
}

/** l'aile tourne avec sa route (°, sur la carte : elle tourne aussi avec la carte) ; null : droit à l'écran quoi que
 *  fasse la carte (à pied, en voiture), jamais à l'envers */
const iconRotation = (kind, crs) => (kind === 'air' ? (typeof crs === 'number' ? crs : 0) : null);
