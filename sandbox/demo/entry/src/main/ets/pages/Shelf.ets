import { ShelfRow } from '../components/ShelfRow'

@Entry
@Component
struct Shelf {
  @State title: string = 'Books'

  build() {
    Column() {
      ShelfRow({ title: this.title })
      Button('Rename').onClick(() => {
        this.title = 'Novels'
      })
    }
  }
}
