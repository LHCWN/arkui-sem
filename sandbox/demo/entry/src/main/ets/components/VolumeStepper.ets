@ComponentV2
export struct VolumeStepper {
  @Param value: number = 0
  @Event changeValue: (value: number) => void

  build() {
    Row() {
      Button('-').onClick(() => {
        this.changeValue(this.value - 1)
      })
      Text(`${this.value}`)
      Button('+').onClick(() => {
        this.changeValue(this.value + 1)
      })
    }
  }
}
