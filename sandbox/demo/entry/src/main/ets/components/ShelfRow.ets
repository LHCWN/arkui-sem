@Component
export struct ShelfRow {
  @Prop title: string = ''

  build() {
    Text(this.title)
  }
}
