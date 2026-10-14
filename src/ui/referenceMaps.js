// Reference images are imported through Vite so URLs work under any base path.
import legend from '../../assets/reference-maps/route-legend.jpeg';
import schematic from '../../assets/reference-maps/route-schematic.jpeg';
import geographic from '../../assets/reference-maps/route-geographic-map.jpeg';

const items = [
  { title: 'Route legend (names, colors)', url: legend },
  { title: 'Route schematic', url: schematic },
  { title: 'Geographic map', url: geographic },
];

export function renderReferenceMaps(container) {
  container.innerHTML = items
    .map((i) => `<li><a href="${i.url}" target="_blank" rel="noopener"><img src="${i.url}" alt="" loading="lazy" width="96" height="72"><span>${i.title}</span></a></li>`)
    .join('');
}
