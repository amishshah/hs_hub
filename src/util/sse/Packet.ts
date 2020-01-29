export enum PacketTypeEnum {
    ITEM_ADD = 0,
    ITEM_DELETE = 1,
    ITEM_UPDATE = 2
}

export interface SSEHardwareItem {
    itemID: number, // number (1, 2, 3,...)
    itemName: string, // string
    itemURL: string, // string
    itemStock: number, // number: the total number of this item at the hackathon
    itemsLeft: number, // number: the number of this item still available to loan
    itemHasStock: boolean, // boolean: itemsLeft > 0
}