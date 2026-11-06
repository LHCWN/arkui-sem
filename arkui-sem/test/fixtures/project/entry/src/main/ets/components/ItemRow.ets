import { Item } from 'common';

@Component
export struct ItemRow {
  @ObjectLink item: Item;

  build() {
    Text(this.item.title)
  }
}
