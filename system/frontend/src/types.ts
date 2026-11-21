export type Intersection = {
  id: string
  name: string
  district: string
  address: string
  lat: number
  lon: number
  date: string
}
export const districts = [
  '월곶동',
  '군자동',
  '장곡동',
  '능곡동',
  '연성동',
  '목감동',
]
export const displayName = (site: Intersection) =>
  site.name
    .replace(/\s+3R$/, ' 삼거리')
    .replace(/교차로 삼거리$/, '교차로')
    .replaceAll(' ', '')
export const siteNumber = (site: Intersection) => site.id.split('_')[1]
