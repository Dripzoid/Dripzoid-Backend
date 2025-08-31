export const placeOrder = async (req, res) => {
  try {
    const { order, items, total } = req.body;

    // TODO: Save order to DB
    // TODO: Update product stock
    // TODO: Clear cart

    res.status(200).json({
      message: "Order placed successfully",
      order,
    });
  } catch (error) {
    console.error("Error placing order:", error);
    res.status(500).json({ message: "Something went wrong" });
  }
};
