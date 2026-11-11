import { VolumeStepper } from '../components/VolumeStepper'

@Entry
@ComponentV2
struct Volume {
  @Local volume: number = 5

  build() {
    Column() {
      Text(`Volume: ${this.volume}`)
      VolumeStepper({ value: this.volume })
    }
  }
}
